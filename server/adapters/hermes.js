#!/usr/bin/env node
/**
 * Hermes 适配器
 * 从 ~/.hermes/state.db 轮询工具调用记录，转换为统一格式
 */

const fs = require('fs');
const path = require('path');
const BaseAdapter = require('./base');
const { insertTimeline } = require('../agent-lens-db');
const { ensureRuntimeDirs, getRuntimePaths } = require('../runtime-paths');

const { hermes: { stateDb: STATE_DB } } = require('../paths');

class HermesAdapter extends BaseAdapter {
    constructor() {
        super();
        this._db = null;
        this._prepared = {};
        this._collectTimer = null;
        this._collecting = false; // ponytail: 防并发 collect
        this._lastTsBySession = new Map(); // sessionId → lastImportedTimestamp (unix seconds)
        const runtimePaths = getRuntimePaths({ baseDir: path.join(__dirname, '..') });
        ensureRuntimeDirs(runtimePaths);
        this._collectStateFile = path.join(runtimePaths.stateDir, 'hermes-collect-state.json');
    }

    get name() {
        return 'hermes';
    }

    // ─── 数据库连接 ─────────────────────────────────────────

    /**
     * 懒加载 SQLite 连接（只读，不写入 Hermes 的数据库）
     * @returns {import('better-sqlite3').Database|null}
     */
    _getDb() {
        if (this._db) return this._db;
        if (!fs.existsSync(STATE_DB)) return null;

        try {
            const Database = require('better-sqlite3');
            this._db = new Database(STATE_DB, { readonly: true, fileMustExist: true });
            return this._db;
        } catch (e) {
            this.logError(e, 'hermes:db');
            return null;
        }
    }

    /**
     * 预编译常用查询
     */
    _ensurePrepared() {
        if (Object.keys(this._prepared).length > 0) return;
        const db = this._getDb();
        if (!db) return;

        this._prepared.findAssistantByToolCallId = db.prepare(`
            SELECT m.id, m.timestamp, m.tool_calls
            FROM messages m, json_each(m.tool_calls) j
            WHERE m.role = 'assistant' AND m.tool_calls IS NOT NULL
            AND json_extract(j.value, '$.id') = ?
            ORDER BY m.id DESC
            LIMIT 1
        `);
    }

    // ─── PreToolUse ────────────────────────────────────────

    /**
     * Hermes 通过插件系统支持 hooks (post_tool_call)
     * fs.watch 作为兜底机制，确保插件未加载时仍能收集数据
     */
    async pre(data) {
        // no-op
    }

    // ─── PostToolUse ───────────────────────────────────────

    /**
     * 从 tool_calls JSON 中提取指定 tool_call_id 的输入
     * @param {string} toolCallsJson - assistant 消息的 tool_calls 字段
     * @param {string} toolCallId - 要匹配的 tool_call_id
     * @returns {{ toolName: string, args: Object }|null}
     */
    _extractToolCallInput(toolCallsJson, toolCallId) {
        try {
            const toolCalls = JSON.parse(toolCallsJson);
            if (!Array.isArray(toolCalls)) return null;

            const tc = toolCalls.find(t => (t.id || t.call_id) === toolCallId);
            if (!tc) return null;

            const toolName = tc.function?.name || tc.name || 'unknown';
            let args = {};
            if (tc.function?.arguments) {
                args = typeof tc.function.arguments === 'string'
                    ? JSON.parse(tc.function.arguments)
                    : tc.function.arguments;
            }

            return { toolName, args };
        } catch (_) {
            return null;
        }
    }

    /**
     * 摘要化 Hermes 工具输入
     * @param {string} toolName
     * @param {Object} args
     * @returns {Object}
     */
    summarizeInput(toolName, args) {
        if (!args || typeof args !== 'object') return {};

        const summary = {};

        if (toolName === 'terminal' || toolName === 'execute_code') {
            const cmd = String(args.command || args.code || '');
            summary.command = cmd.length > 120 ? cmd.substring(0, 120) + '…' : cmd;
        } else if (toolName === 'read_file' || toolName === 'write_file') {
            summary.file_path = args.file_path || args.path || '';
        } else if (toolName === 'patch' || toolName === 'file_editor') {
            summary.file_path = args.file_path || args.path || '';
            if (args.old_string) {
                summary.old_len = args.old_string.length;
                summary.new_len = (args.new_string || '').length;
            }
        } else if (toolName === 'search_files') {
            summary.pattern = args.pattern || args.query || '';
            summary.path = args.path || '';
        } else if (toolName === 'process') {
            const action = args.action || '';
            const sid = args.session_id ? args.session_id.replace('proc_', '') : '';
            const sidShort = sid.length > 8 ? sid.substring(0, 8) + '…' : sid;
            if (action === 'submit') {
                const data = String(args.data || '').substring(0, 60);
                summary.description = `submit → ${sidShort}: ${data}`;
            } else if (action === 'log') {
                summary.description = `log(limit=${args.limit || '?'}) → ${sidShort}`;
            } else if (action === 'wait') {
                summary.description = `wait(timeout=${args.timeout || '?'}s) → ${sidShort}`;
            } else {
                summary.description = `${action} → ${sidShort}`;
            }
        } else if (toolName === 'todo') {
            const todos = args.todos || [];
            if (args.merge && todos.length > 0) {
                const done = todos.filter(t => t.status === 'completed').length;
                summary.description = `${todos.length}项 (${done}完成)`;
            } else if (todos.length > 0) {
                summary.description = todos.map(t => {
                    const icon = t.status === 'completed' ? '✅' : '⬜';
                    return `${icon}${t.content || ''}`;
                }).join(' | ').substring(0, 120);
            } else {
                summary.description = args.content || args.action || '';
            }
        } else if (toolName === 'clarify') {
            summary.description = String(args.question || '').substring(0, 120);
            if (Array.isArray(args.choices) && args.choices.length > 0) {
                summary.description += ` [${args.choices.length}个选项]`;
            }
        } else if (toolName === 'send_message') {
            const target = args.target || '';
            const msg = String(args.message || '').substring(0, 60);
            summary.description = `→ ${target}: ${msg}`;
        } else if (toolName === 'delegate_task') {
            const tasks = args.tasks || [];
            if (tasks.length > 0) {
                summary.description = tasks.map(t => t.goal || t.description || '').join(' | ').substring(0, 120);
            } else {
                summary.description = String(args.description || args.goal || '').substring(0, 120);
            }
        } else if (toolName === 'memory') {
            const action = args.action || '';
            const content = String(args.content || args.old_text || '').substring(0, 60);
            summary.description = content ? `${action}: ${content}` : action;
        } else if (toolName === 'session_search') {
            summary.query = String(args.query || args.keyword || '').substring(0, 100);
        } else if (toolName === 'browser_console') {
            summary.command = String(args.expression || '').substring(0, 120);
        } else if (toolName === 'browser_vision' || toolName === 'vision_analyze') {
            summary.question = String(args.question || '').substring(0, 100);
        } else if (toolName === 'browser_scroll') {
            summary.direction = args.direction || '';
        } else if (toolName === 'browser_click' || toolName === 'browser_type' || toolName === 'browser_press') {
            summary.target = args.target || args.selector || '';
        } else if (toolName === 'browser_navigate') {
            summary.url = String(args.url || '').substring(0, 100);
        } else if (toolName === 'browser_snapshot') {
            summary.description = 'snapshot';
        } else if (toolName === 'web_search') {
            summary.query = String(args.query || '').substring(0, 100);
        } else if (toolName === 'skill_view' || toolName === 'skill_manage') {
            summary.skill = args.name || '';
        } else if (toolName.startsWith('mcp_')) {
            // MCP 工具：提取服务器名和关键参数
            summary.mcp_tool = toolName;
            for (const key of ['query', 'symbol', 'pattern', 'prompt', 'path', 'url', 'question', 'name', 'uid']) {
                if (key in args) {
                    const val = String(args[key]);
                    summary[key] = val.length > 100 ? val.substring(0, 100) + '…' : val;
                }
            }
        } else if (toolName.startsWith('viking_')) {
            summary.description = toolName.replace('viking_', '');
            if (args.query) summary.query = String(args.query).substring(0, 100);
            if (args.uri) summary.uri = String(args.uri).substring(0, 100);
        } else {
            // 通用回退：提取第一个有意义的字符串参数
            const strVal = Object.entries(args).find(([, v]) => typeof v === 'string' && v.length > 0);
            if (strVal) {
                summary[strVal[0]] = String(strVal[1]).substring(0, 100);
            } else {
                summary.keys = Object.keys(args).slice(0, 8);
            }
        }

        return summary;
    }

    /**
     * 判断工具调用是否成功
     * @param {string} contentJson - tool 消息的 content 字段（JSON 字符串）
     * @returns {{ success: boolean, error: string|null, exitCode: number|null }}
     */
    _judgeSuccess(contentJson) {
        let success = true;
        let errorMsg = null;
        let exitCode = null;

        try {
            const content = JSON.parse(contentJson);
            exitCode = content.exit_code ?? null;
            if (content.success === false) {
                success = false;
                errorMsg = content.error || 'Tool reported failure';
            }
            if (exitCode !== null && exitCode !== 0) {
                success = false;
                errorMsg = `Exit code ${exitCode}` + (errorMsg ? ': ' + errorMsg : '');
            }
            if (!success && content.error) {
                success = false;
                errorMsg = (errorMsg ? errorMsg + ': ' : '') + String(content.error).substring(0, 300);
            }
        } catch (_) {
            // 非 JSON 格式，无法判断
        }

        return { success, error: errorMsg, exitCode };
    }

    /**
     * 构建统一格式记录
     * @param {Object} msg - 数据库消息行
     * @param {string} sessionId
     * @param {string} projectKey
     * @param {string} projectName
     * @param {string} cwd
     * @returns {Object}
     */
    _buildRecord(msg, sessionId, projectKey, projectName, cwd) {
        // 通过 tool_call_id 查找对应的 assistant 消息获取输入
        let toolName = msg.tool_name || 'unknown';
        let inputSummary = {};

        let assistant = null;
        if (msg.tool_call_id) {
            assistant = this._prepared.findAssistantByToolCallId.get(msg.tool_call_id);

            if (assistant) {
                const extracted = this._extractToolCallInput(assistant.tool_calls, msg.tool_call_id);
                if (extracted) {
                    toolName = extracted.toolName;
                    inputSummary = this.summarizeInput(toolName, extracted.args);
                }
            }
        }

        const { success, error, exitCode } = this._judgeSuccess(msg.content);

        // 计算耗时：tool 消息时间戳 - assistant 消息时间戳
        let durationMs = null;
        if (assistant) {
            durationMs = Math.round((msg.timestamp - assistant.timestamp) * 1000) / 1000;
        }

        // 转换时间戳（秒 -> ISO）
        const ts = new Date(msg.timestamp * 1000).toISOString();

        const record = {
            ts,
            session_id: sessionId,
            project_key: projectKey,
            project_name: projectName,
            tool_name: toolName,
            source: this.name,
            input_summary: inputSummary,
            success,
        };

        if (durationMs !== null) {
            record.duration_ms = durationMs;
        }
        if (!success && error) {
            record.error = error.substring(0, 500).trim();
        }

        return record;
    }

    // ─── getRecords（供 /api/timeline 直接读取 state.db）────────

    /**
     * 从 state.db 查询工具调用记录，返回统一格式
     * @param {Object} filter
     * @param {string} [filter.session_id]
     * @param {string} [filter.project_key]
     * @param {string} [filter.source]
     * @param {number} [filter.limit=1000]
     * @returns {Array}
     */
    async getRecords(filter = {}) {
        const db = this._getDb();
        if (!db) return [];

        const limit = Math.min(parseInt(filter.limit, 10) || 1000, 10000);
        const sessionId = filter.session_id;

        // 查询会话消息，包含对话和工具调用，按时间正序返回给前端复盘。
        let sql = `
            SELECT m.*, s.cwd
            FROM messages m
            LEFT JOIN sessions s ON m.session_id = s.id
            WHERE m.role IN ('user', 'assistant', 'tool')
        `;
        const params = [];

        if (sessionId) {
            sql += ' AND m.session_id = ?';
            params.push(sessionId);
        }

        sql += ' ORDER BY m.timestamp ASC LIMIT ?';
        params.push(limit);

        let messages;
        try {
            messages = db.prepare(sql).all(...params);
        } catch (_) {
            return [];
        }

        // 预编译查找 assistant 消息
        const findAssistant = db.prepare(`
            SELECT m.id, m.timestamp, m.tool_calls
            FROM messages m, json_each(m.tool_calls) j
            WHERE m.role = 'assistant' AND m.tool_calls IS NOT NULL
            AND json_extract(j.value, '$.id') = ?
            ORDER BY m.id DESC
            LIMIT 1
        `);

        const items = [];
        for (const msg of messages) {
            const record = this._buildRecordFromMessage(msg, findAssistant);
            if (!record) continue;
            if (filter.project_key && record.project_key !== filter.project_key) continue;
            if (filter.source && filter.source !== this.name) continue;
            items.push(record);
        }

        return items;
    }

    _buildRecordFromMessage(msg, findAssistant = null) {
        const cwd = msg.cwd || '';
        const projectKey = this.getProjectKey(cwd);
        const projectName = this.getProjectName(cwd);
        const ts = new Date(msg.timestamp * 1000).toISOString();
        const base = {
            ts,
            session_id: msg.session_id,
            project_key: projectKey,
            project_name: projectName,
            cwd,
            source: this.name,
        };

        if (msg.role === 'user' || msg.role === 'assistant') {
            const content = this._extractMessageText(msg.content);
            if (!content) return null;
            return {
                ...base,
                role: msg.role,
                content,
                success: null,
            };
        }

        if (msg.role !== 'tool') return null;

        let toolName = msg.tool_name || 'unknown';
        let inputSummary = {};
        let durationMs = null;
        let assistantTs = null;

        if (msg.tool_call_id && findAssistant) {
            try {
                const assistant = findAssistant.get(msg.tool_call_id);
                if (assistant) {
                    const extracted = this._extractToolCallInput(assistant.tool_calls, msg.tool_call_id);
                    if (extracted) {
                        toolName = extracted.toolName;
                        inputSummary = this.summarizeInput(toolName, extracted.args);
                    }
                    assistantTs = assistant.timestamp;
                }
            } catch (_) {}
        }

        if (assistantTs) {
            durationMs = Math.round((msg.timestamp - assistantTs) * 1000) / 1000;
        }

        const { success, error } = this._judgeSuccess(msg.content);
        const record = {
            ...base,
            role: success ? 'tool_result' : 'tool_error',
            tool_name: toolName,
            input_summary: inputSummary,
            success,
            output_snippet: this._extractToolOutput(msg.content),
        };
        if (durationMs !== null) record.duration_ms = durationMs;
        if (!success && error) record.error = error.substring(0, 500).trim();
        return record;
    }

    _extractMessageText(content) {
        if (content == null) return '';
        if (typeof content !== 'string') return String(content || '').trim();
        const trimmed = content.trim();
        if (!trimmed) return '';
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') return parsed.trim();
            if (parsed && typeof parsed === 'object') {
                return String(parsed.text || parsed.content || parsed.output || trimmed).trim();
            }
        } catch (_) {}
        return trimmed;
    }

    _extractToolOutput(content) {
        try {
            const parsed = typeof content === 'string' ? JSON.parse(content) : content;
            const text = parsed?.output || parsed?.text || parsed?.error || '';
            return text ? String(text).substring(0, 500) : null;
        } catch (_) {
            return null;
        }
    }

    // ─── 直接查询 state.db（供 API 使用）─────────────────────

    /**
     * 从 state.db 查询 session 列表
     * @param {Object} filter
     * @param {string} [filter.project_key]
     * @param {number} [filter.limit=50]
     * @returns {Array}
     */
    async getSessions(filter = {}) {
        const db = this._getDb();
        if (!db) return [];

        const limit = Math.min(parseInt(filter.limit, 10) || 50, 200);

        let sql = 'SELECT * FROM sessions';
        const params = [];

        if (filter.project_key) {
            sql += ' WHERE cwd IS NOT NULL';
            // 需要在应用层过滤 project_key（因为 state.db 没有 project_key 字段）
        }

        sql += ' ORDER BY started_at DESC LIMIT ?';
        params.push(limit);

        let sessions;
        try {
            sessions = db.prepare(sql).all(...params);
        } catch (_) {
            return [];
        }

        // 转换为统一格式
        return sessions
            .map(s => {
                const cwd = s.cwd || '';
                const projectKey = this.getProjectKey(cwd);
                // 过滤 project_key
                if (filter.project_key && projectKey !== filter.project_key) return null;
                return {
                    session_id: s.id,
                    project_key: projectKey,
                    source: this.name,
                    start_time: s.started_at ? new Date(s.started_at * 1000).toISOString() : '',
                    end_time: s.ended_at ? new Date(s.ended_at * 1000).toISOString() : '',
                    tool_count: s.tool_call_count || 0,
                    error_count: 0, // state.db 没有直接的错误计数
                    total_duration_ms: 0,
                };
            })
            .filter(Boolean)
            .slice(0, limit);
    }

    /**
     * 从 state.db 聚合统计数据
     * @param {Object} filter
     * @param {string} [filter.since] - 日期字符串 YYYY-MM-DD
     * @returns {Object} { totals, byTool, bySource, byDay }
     */
    async getStats(filter = {}) {
        const db = this._getDb();
        if (!db) return { totals: { total_calls: 0, total_errors: 0, session_count: 0 }, byTool: [], bySource: [], byDay: [] };

        try {
            // 按工具聚合
            let toolSql = `
                SELECT tool_name, COUNT(*) as count,
                       SUM(CASE WHEN content LIKE '%"exit_code":%' OR content LIKE '%"error"%' THEN 1 ELSE 0 END) as errors
                FROM messages WHERE role = 'tool'
            `;
            const toolParams = [];
            if (filter.since) {
                toolSql += ' AND timestamp >= ?';
                toolParams.push(new Date(filter.since).getTime() / 1000);
            }
            toolSql += ' GROUP BY tool_name ORDER BY count DESC';
            const byTool = db.prepare(toolSql).all(...toolParams);

            // 按天聚合
            let daySql = `
                SELECT date(timestamp, 'unixepoch', 'localtime') as date, COUNT(*) as count,
                       SUM(CASE WHEN content LIKE '%"exit_code":%' OR content LIKE '%"error"%' THEN 1 ELSE 0 END) as errors
                FROM messages WHERE role = 'tool'
            `;
            const dayParams = [];
            if (filter.since) {
                daySql += ' AND timestamp >= ?';
                dayParams.push(new Date(filter.since).getTime() / 1000);
            }
            daySql += ' GROUP BY date ORDER BY date ASC';
            const byDay = db.prepare(daySql).all(...dayParams);

            // 总体统计
            let totalSql = `
                SELECT COUNT(*) as total_calls,
                       SUM(CASE WHEN content LIKE '%"exit_code":%' OR content LIKE '%"error"%' THEN 1 ELSE 0 END) as total_errors
                FROM messages WHERE role = 'tool'
            `;
            const totalParams = [];
            if (filter.since) {
                totalSql += ' AND timestamp >= ?';
                totalParams.push(new Date(filter.since).getTime() / 1000);
            }
            const totals = db.prepare(totalSql).get(...totalParams);

            // session 数量
            let sessionSql = 'SELECT COUNT(*) as session_count FROM sessions';
            const sessionParams = [];
            if (filter.since) {
                sessionSql += ' WHERE started_at >= ?';
                sessionParams.push(new Date(filter.since).getTime() / 1000);
            }
            const sessionCount = db.prepare(sessionSql).get(...sessionParams);
            totals.session_count = sessionCount.session_count;

            return {
                totals,
                byTool,
                bySource: [{ source: this.name, count: totals.total_calls, errors: totals.total_errors }],
                byDay,
            };
        } catch (_) {
            return { totals: { total_calls: 0, total_errors: 0, session_count: 0 }, byTool: [], bySource: [], byDay: [] };
        }
    }

    /**
     * 从 state.db 聚合工具使用统计
     * @returns {Array} [{ tool_name, count, errors }]
     */
    async getTools() {
        const db = this._getDb();
        if (!db) return [];
        try {
            return db.prepare(`
                SELECT tool_name, COUNT(*) as count,
                       SUM(CASE WHEN content LIKE '%"exit_code":%' OR content LIKE '%"error"%' THEN 1 ELSE 0 END) as errors
                FROM messages WHERE role = 'tool'
                GROUP BY tool_name ORDER BY count DESC
            `).all();
        } catch (_) {
            return [];
        }
    }

    // ─── Timeline 收集 ─────────────────────────────────────

    /** 从文件加载水位线 */
    _loadCollectState() {
        try {
            if (fs.existsSync(this._collectStateFile)) {
                const data = JSON.parse(fs.readFileSync(this._collectStateFile, 'utf-8'));
                if (data.sessions) {
                    for (const [sid, ts] of Object.entries(data.sessions)) {
                        this._lastTsBySession.set(sid, ts);
                    }
                }
            }
        } catch (_) {}
    }

    /** 保存水位线到文件 */
    _saveCollectState() {
        try {
            const dir = path.dirname(this._collectStateFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const sessions = {};
            for (const [sid, ts] of this._lastTsBySession) {
                sessions[sid] = ts;
            }
            fs.writeFileSync(this._collectStateFile, JSON.stringify({ sessions }, null, 2), 'utf-8');
        } catch (_) {}
    }

    /**
     * 从 state.db 读取新记录并写入 timeline 表
     */
    async collect() {
        if (this._collecting) return; // ponytail: 跳过上一轮还没跑完的
        this._collecting = true;
        // 使用独立连接，避免与其他方法（getRecords等）冲突
        let collectDb = null;
        try {
            const Database = require('better-sqlite3');
            if (!fs.existsSync(STATE_DB)) return;
            // 补上 watcher（文件在启动后创建的情况）
            if (!this._watcher) this._startWatcher();
            collectDb = new Database(STATE_DB, { readonly: true, fileMustExist: true });
        } catch (e) {
            return;
        }

        try {
            // 准备 assistant 查询（在 collectDb 上）
            const findAssistant = collectDb.prepare(`
                SELECT m.id, m.timestamp, m.tool_calls
                FROM messages m, json_each(m.tool_calls) j
                WHERE m.role = 'assistant' AND m.tool_calls IS NOT NULL
                AND json_extract(j.value, '$.id') = ?
                ORDER BY m.id DESC
                LIMIT 1
            `);

            let whereClause = `WHERE m.role IN ('user', 'assistant', 'tool')`;
            
            // 优化：用水位线最小值过滤，避免全表扫描
            if (this._lastTsBySession.size > 0) {
                const minTs = Math.min(...this._lastTsBySession.values());
                if (minTs > 0) {
                    whereClause += ` AND m.timestamp > ${minTs}`;
                }
            }
            
            // ponytail: 加 LIMIT 防全表扫描卡死，459MB 的 db 全扫太慢
            const stmt = collectDb.prepare(`
                SELECT m.*, s.cwd
                FROM messages m
                LEFT JOIN sessions s ON m.session_id = s.id
                ${whereClause}
                ORDER BY m.timestamp ASC
                LIMIT 5000
            `);

            const BATCH = 100;
            let count = 0;
            let batch = [];

            const { getDb: getAgentLensDb } = require('../agent-lens-db');
            const flush = () => {
                if (batch.length === 0) return;
                const agentLensDb = getAgentLensDb();
                const tx = agentLensDb.transaction((rows) => {
                    for (const msg of rows) {
                        insertTimeline(msg);
                    }
                });
                tx(batch);
                batch = [];
            };

            for (const msg of stmt.iterate()) {
                const sessionId = msg.session_id;
                if (!sessionId) continue;

                const lastTs = this._lastTsBySession.get(sessionId) || 0;
                if (msg.timestamp <= lastTs) continue;

                const cwd = msg.cwd || '';
                const projectKey = this.getProjectKey(cwd);
                const ts = new Date(msg.timestamp * 1000).toISOString();

                // 根据 state.db 的 role 映射到 timeline role
                let timelineRole;
                let content = null;
                let toolName = null;
                let toolInput = null;
                let success = null;
                let outputSnippet = null;
                let errorMessage = null;

                if (msg.role === 'user') {
                    timelineRole = 'user';
                    try {
                        content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
                        if (content && typeof content === 'string') content = content.substring(0, 2000);
                    } catch (_) {
                        content = String(msg.content || '').substring(0, 2000);
                    }
                } else if (msg.role === 'assistant') {
                    timelineRole = 'assistant';
                    try {
                        content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
                        if (content && typeof content === 'string') content = content.substring(0, 2000);
                    } catch (_) {
                        content = String(msg.content || '').substring(0, 2000);
                    }
                } else if (msg.role === 'tool') {
                    // tool 消息 → tool_result 或 tool_error
                    const { success: isSuccess, error: err } = this._judgeSuccess(msg.content);
                    timelineRole = isSuccess ? 'tool_result' : 'tool_error';
                    success = isSuccess ? 1 : 0;
                    errorMessage = err;

                    // 提取 tool_name（从 assistant 的 tool_calls 反查）
                    if (msg.tool_call_id) {
                        try {
                            const assistant = findAssistant.get(msg.tool_call_id);
                            if (assistant) {
                                const extracted = this._extractToolCallInput(assistant.tool_calls, msg.tool_call_id);
                                if (extracted) {
                                    toolName = extracted.toolName;
                                    toolInput = this.summarizeInput(toolName, extracted.args);
                                }
                            }
                        } catch (_) {}
                    }

                    // 提取 content
                    try {
                        const parsed = JSON.parse(msg.content);
                        content = parsed.text || parsed.output || null;
                        if (content && typeof content === 'string') content = content.substring(0, 2000);
                    } catch (_) {}
                    outputSnippet = content ? content.substring(0, 500) : null;
                }

                batch.push({
                    source: this.name,
                    session_id: sessionId,
                    timestamp: ts,
                    seq: null,
                    role: timelineRole,
                    tool_name: toolName,
                    content,
                    tool_input: toolInput,
                    success,
                    exit_code: null,
                    duration_ms: null,
                    output_snippet: outputSnippet,
                    error_message: errorMessage,
                    project_key: projectKey,
                    parent_seq: null,
                });

                this._lastTsBySession.set(sessionId, msg.timestamp);
                count++;

                if (batch.length >= BATCH) {
                    flush();
                    this._saveCollectState();
                    await new Promise(r => setImmediate(r));
                }
            }
            flush();
            this._saveCollectState();
            if (count > 0) console.log(`hermes:collect 导入 ${count} 条记录`);
        } catch (e) {
            this.logError(e, 'hermes:collect');
        } finally {
            this._collecting = false;
            if (collectDb) { try { collectDb.close(); } catch (_) {} }
        }
    }

    startCollecting(intervalMs = 30 * 60 * 1000) {
        if (this._collectTimer) return;
        // 优先从文件恢复水位线
        this._loadCollectState();
        // 文件为空时从 timeline 表恢复（fallback）
        if (this._lastTsBySession.size === 0) {
            try {
                const { getDb } = require('../agent-lens-db');
                const db = getDb();
                if (db) {
                    const rows = db.prepare(`
                        SELECT session_id, MAX(timestamp) as max_ts
                        FROM timeline WHERE source = 'hermes'
                        GROUP BY session_id
                    `).all();
                    for (const row of rows) {
                        const ts = new Date(row.max_ts).getTime() / 1000;
                        if (ts > 0) this._lastTsBySession.set(row.session_id, ts);
                    }
                }
            } catch (_) {}
        }
        // 延迟首次 collect，避免阻塞服务器启动
        setTimeout(() => this.collect(), 0);
        this._collectTimer = setInterval(() => this.collect(), intervalMs);

        // 实时监听 state.db 变化，有新数据立即 collect
        this._startWatcher();
    }

    _startWatcher() {
        if (this._watcher || !fs.existsSync(STATE_DB)) return;
        try {
            this._watchDebounce = null;
            this._watcher = fs.watch(STATE_DB, (eventType) => {
                if (eventType !== 'change') return;
                // 防抖：2秒内的多次变化只触发一次 collect
                if (this._watchDebounce) clearTimeout(this._watchDebounce);
                this._watchDebounce = setTimeout(() => {
                    this.collect().catch(() => {});
                }, 2000);
            });
            this._watcher.on('error', () => {
                // watcher 出错时静默，30分钟定时兜底
                this._watcher = null;
            });
        } catch (_) {
            // fs.watch 失败时静默，定时轮询兜底
        }
    }

    stopCollecting() {
        if (this._collectTimer) {
            clearInterval(this._collectTimer);
            this._collectTimer = null;
        }
        if (this._watcher) {
            try { this._watcher.close(); } catch (_) {}
            this._watcher = null;
        }
        if (this._watchDebounce) {
            clearTimeout(this._watchDebounce);
            this._watchDebounce = null;
        }
        this._saveCollectState();
    }
}

module.exports = HermesAdapter;
