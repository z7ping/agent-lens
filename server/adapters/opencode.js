#!/usr/bin/env node
/**
 * OpenCode 适配器
 * 从 ~/.local/share/opencode/opencode.db 轮询对话文本和工具调用记录，转换为统一格式
 * 数据源：part 表（type='text' / type='tool' 的记录），通过 message 表获取角色、session 表获取项目目录
 */

const fs = require('fs');
const path = require('path');
const BaseAdapter = require('./base');

const { opencode: { db: OPENCODE_DB } } = require('../paths');
// 可配置：轮询间隔（毫秒），默认 30 分钟
const POLL_INTERVAL_MS = parseInt(process.env.OPENCODE_POLL_INTERVAL_MS, 10) || 30 * 60 * 1000;
// 可配置：每次轮询最大处理条数，默认 100
const POLL_BATCH_SIZE = parseInt(process.env.OPENCODE_POLL_BATCH_SIZE, 10) || 100;

class OpenCodeAdapter extends BaseAdapter {
    constructor() {
        super();
        this._pollTimer = null;
        this._db = null;
        this._prepared = {};
        this._lastProcessedTs = 0; // 已处理的最高 time_created
        this._lastTsLoaded = false;
        this._conversationBackfilled = false;
        this._watcher = null;
        this._watchDebounce = null;
    }

    get name() {
        return 'opencode';
    }

    // ─── 数据库连接 ─────────────────────────────────────────

    /**
     * 懒加载 SQLite 连接（只读）
     * @returns {import('better-sqlite3').Database|null}
     */
    async _getDb() {
        if (this._db) return this._db;
        if (!fs.existsSync(OPENCODE_DB)) return null;

        try {
            const { openDb } = require('../db');
            this._db = openDb(OPENCODE_DB, { readonly: true });
            await this._db.ready();
            return this._db;
        } catch (e) {
            this.logError(e, 'opencode:db');
            return null;
        }
    }

    _loadLastProcessedTs() {
        if (this._lastTsLoaded) return;
        this._lastTsLoaded = true;

        try {
            const abeatDb = require('../abeat-db').getDb();
            const row = abeatDb.prepare(`
                SELECT MAX(timestamp) AS max_ts
                FROM timeline
                WHERE source = 'opencode'
            `).get();
            const ts = row?.max_ts ? new Date(row.max_ts).getTime() : 0;
            if (ts > 0) this._lastProcessedTs = ts;
        } catch (_) {}
    }

    /**
     * 预编译常用查询
     */
    async _ensurePrepared() {
        if (Object.keys(this._prepared).length > 0) return;
        const db = await this._getDb();
        if (!db) return;

        // 查询未处理的可展示 part：text 用于对话，tool 用于工具统计
        this._prepared.fetchParts = db.prepare(`
            SELECT p.id, p.message_id, p.session_id, p.time_created, p.data,
                   m.data AS message_data,
                   s.directory
            FROM part p
            LEFT JOIN message m ON p.message_id = m.id
            LEFT JOIN session s ON p.session_id = s.id
            WHERE (p.data LIKE '%"type":"tool"%' OR p.data LIKE '%"type":"text"%')
              AND p.time_created > ?
            ORDER BY p.time_created ASC
            LIMIT ?
        `);

        // 标记已处理（使用时间戳水位线）
        this._prepared.getLastTs = db.prepare(`
            SELECT MAX(time_created) as max_ts FROM part
            WHERE time_created <= ?
        `);

        this._prepared.fetchConversationParts = db.prepare(`
            SELECT p.id, p.message_id, p.session_id, p.time_created, p.data,
                   m.data AS message_data,
                   s.directory
            FROM part p
            LEFT JOIN message m ON p.message_id = m.id
            LEFT JOIN session s ON p.session_id = s.id
            WHERE p.data LIKE '%"type":"text"%'
            ORDER BY p.time_created ASC
            LIMIT ?
        `);
    }

    // ─── PreToolUse ────────────────────────────────────────

    /**
     * OpenCode 无 PreToolUse 钩子，轮询模式下无需 pre()
     */
    async pre(data) {
        // no-op
    }

    // ─── PostToolUse ───────────────────────────────────────

    /**
     * 摘要化 OpenCode 工具输入
     * @param {string} toolName
     * @param {Object} input
     * @returns {Object}
     */
    _summarizeInput(toolName, input) {
        if (!input || typeof input !== 'object') return {};

        const summary = {};

        if (toolName === 'bash') {
            const cmd = String(input.command || '');
            summary.command = cmd.length > 120 ? cmd.substring(0, 120) + '…' : cmd;
        } else if (toolName === 'read') {
            summary.file_path = input.filePath || input.file_path || '';
        } else if (toolName === 'write' || toolName === 'edit') {
            summary.file_path = input.filePath || input.file_path || '';
        } else if (toolName === 'grep') {
            summary.pattern = String(input.pattern || '').substring(0, 100);
            summary.path = input.path || '';
        } else if (toolName === 'task') {
            summary.description = String(input.description || '').substring(0, 100);
        } else {
            summary.keys = Object.keys(input).slice(0, 8);
        }

        return summary;
    }

    /**
     * 判断工具调用是否成功
     * @param {string} status - part state.status
     * @param {string} output - part state.output（文本）
     * @returns {{ success: boolean, error: string|null }}
     */
    _judgeSuccess(status, output) {
        let success = true;
        let errorMsg = null;

        // 基于 status 判断
        if (status && status !== 'completed') {
            success = false;
            errorMsg = `Status: ${status}`;
        }

        return { success, error: errorMsg };
    }

    /**
     * 从 part data JSON 中提取并转换为统一格式
     * @param {Object} row - 数据库行
     * @returns {Object|null}
     */
    _buildRecord(row) {
        let data;
        try {
            data = JSON.parse(row.data);
        } catch (_) {
            return null;
        }

        // 对话文本：角色在 message.data JSON 中，文本在 part.data.text 中
        if (data.type === 'text') {
            let messageData = {};
            try {
                messageData = row.message_data ? JSON.parse(row.message_data) : {};
            } catch (_) {}

            const role = messageData.role;
            const content = String(data.text || '').trim();
            if (!content || !['user', 'assistant'].includes(role)) return null;

            const ts = new Date(row.time_created).toISOString();
            const cwd = row.directory || messageData.path?.cwd || process.cwd();
            const projectKey = this.getProjectKey(cwd);
            const projectName = this.getProjectName(cwd);

            return {
                ts,
                session_id: row.session_id,
                project_key: projectKey,
                project_name: projectName,
                source: this.name,
                role,
                content: content.substring(0, 2000),
                success: null,
            };
        }

        // 工具调用
        if (data.type !== 'tool') return null;

        const toolName = data.tool || 'unknown';
        const state = data.state || {};
        const input = state.input || {};
        const output = state.output || '';

        // 计算耗时（time.start / time.end 为毫秒时间戳）
        let durationMs = null;
        if (state.time && typeof state.time.start === 'number' && typeof state.time.end === 'number') {
            durationMs = Math.round((state.time.end - state.time.start) * 1000) / 1000;
        }

        // 判断成功/失败
        const { success, error } = this._judgeSuccess(state.status, output);

        // 从 part.time_created 获取 ISO 时间戳（毫秒）
        const ts = new Date(row.time_created).toISOString();

        // 从 session.directory 获取项目目录
        const cwd = row.directory || process.cwd();
        const projectKey = this.getProjectKey(cwd);
        const projectName = this.getProjectName(cwd);

        const record = {
            ts,
            session_id: row.session_id,
            project_key: projectKey,
            project_name: projectName,
            tool_name: toolName,
            source: this.name,
            role: success ? 'tool_result' : 'tool_error',
            input_summary: this._summarizeInput(toolName, input),
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

    /**
     * 轮询一次：读取未处理的 text/tool part，转换并写入 timeline/统计
     */
    async _pollOnce() {
        await this._ensurePrepared();
        const db = await this._getDb();
        if (!db || !this._prepared.fetchParts) return;
        this._loadLastProcessedTs();
        this._backfillConversationParts();

        // 补上 watcher（文件在启动后创建的情况）
        if (!this._watcher && fs.existsSync(OPENCODE_DB)) this._startWatcher();

        try {
            const fetchedParts = this._prepared.fetchParts.all(this._lastProcessedTs, POLL_BATCH_SIZE);
            if (fetchedParts.length === 0) return;

            // 按 session 分组处理
            const bySession = new Map();
            for (const part of fetchedParts) {
                const sid = part.session_id;
                if (!bySession.has(sid)) bySession.set(sid, []);
                bySession.get(sid).push(part);
            }

            for (const [sessionId, parts] of bySession) {
                const cwd = parts[0].directory || process.cwd();
                const projectKey = this.getProjectKey(cwd);
                const projectName = this.getProjectName(cwd);
                const existingStats = this._getExistingSessionStats(sessionId);
                const sessionStats = {
                    session_id: sessionId,
                    project_key: projectKey,
                    source: 'opencode',
                    start_time: existingStats?.start_time || '',
                    end_time: existingStats?.end_time || '',
                    tool_count: existingStats?.tool_count || 0,
                    error_count: existingStats?.error_count || 0,
                    total_duration_ms: existingStats?.total_duration_ms || 0,
                };

                this.updateProjectsFile(projectKey, cwd, projectName);

                for (const part of parts) {
                    const record = this._buildRecord(part);
                    if (!record) continue;

                    // 聚合写入 a-beat.db
                    this._aggregateToDb(record, sessionId, projectKey);

                    if (record.ts && (!sessionStats.start_time || record.ts < sessionStats.start_time)) sessionStats.start_time = record.ts;
                    if (record.ts && (!sessionStats.end_time || record.ts > sessionStats.end_time)) sessionStats.end_time = record.ts;
                    if (this._isToolRecord(record)) {
                        sessionStats.tool_count += 1;
                        if (!record.success) sessionStats.error_count += 1;
                        sessionStats.total_duration_ms += record.duration_ms || 0;
                    }
                }

                try {
                    require('../abeat-db').upsertSession(sessionStats);
                } catch (_) {}
            }

            // 更新水位线：取本次处理的最高 time_created
            const maxTs = Math.max(...fetchedParts.map(p => p.time_created));
            if (maxTs > this._lastProcessedTs) {
                this._lastProcessedTs = maxTs;
            }
        } catch (e) {
            this.logError(e, 'opencode:poll');
        }
    }

    _isToolRecord(record) {
        return record.role === 'tool_result' || record.role === 'tool_error' || Boolean(record.tool_name);
    }

    _getExistingSessionStats(sessionId) {
        try {
            const abeatDb = require('../abeat-db').getDb();
            return abeatDb.prepare(`
                SELECT start_time, end_time, tool_count, error_count, total_duration_ms
                FROM sessions
                WHERE source = 'opencode' AND session_id = ?
            `).get(sessionId);
        } catch (_) {
            return null;
        }
    }

    _backfillConversationParts() {
        if (this._conversationBackfilled || !this._prepared.fetchConversationParts) return;
        this._conversationBackfilled = true;

        try {
            const parts = this._prepared.fetchConversationParts.all(10000);
            for (const part of parts) {
                const record = this._buildRecord(part);
                if (!record || !['user', 'assistant'].includes(record.role)) continue;

                const cwd = part.directory || process.cwd();
                this.updateProjectsFile(record.project_key, cwd, record.project_name);
                this._aggregateToDb(record, record.session_id, record.project_key);
            }
        } catch (e) {
            this.logError(e, 'opencode:conversation-backfill');
        }
    }

    _aggregateToDb(record, sessionId, projectKey) {
        try {
            const abeatDb = require('../abeat-db');
            const ts = record.ts || '';
            const date = ts.slice(0, 10);
            const isTool = this._isToolRecord(record);
            const toolInput = record.input_summary == null
                ? null
                : (typeof record.input_summary === 'string' ? record.input_summary : JSON.stringify(record.input_summary || {}));

            if (isTool) {
                // 按天统计
                abeatDb.updateDailyStats(date, 'opencode', record.tool_name, 1, record.success ? 0 : 1, record.duration_ms || 0);

                // 错误记录
                if (!record.success && record.error) {
                    abeatDb.saveError(ts, sessionId, 'opencode', record.tool_name, record.error);
                }
            }

            // 写入 timeline（轮询兜底）
            abeatDb.insertTimeline({
                source: 'opencode',
                session_id: sessionId,
                timestamp: ts,
                seq: null,
                role: record.role || (record.success ? 'tool_result' : 'tool_error'),
                tool_name: record.tool_name || null,
                content: record.content || null,
                tool_input: toolInput,
                success: record.success == null ? null : (record.success ? 1 : 0),
                exit_code: null,
                duration_ms: record.duration_ms ?? null,
                output_snippet: null,
                error_message: record.error || null,
                error_type: null,
                error_detail: null,
                project_key: projectKey,
                parent_seq: null,
            });
        } catch (_) {}
    }

    // ─── getRecords（供 /api/timeline 直接读取 opencode.db）──────

    /**
     * 从 opencode.db 查询工具调用记录，返回统一格式
     * @param {Object} filter
     * @param {string} [filter.session_id]
     * @param {string} [filter.project_key]
     * @param {string} [filter.source]
     * @param {number} [filter.limit=1000]
     * @returns {Array}
     */
    async getRecords(filter = {}) {
        const db = await this._getDb();
        if (!db) return [];

        const limit = Math.min(parseInt(filter.limit, 10) || 1000, 10000);
        const sessionId = filter.session_id;

        let sql = `
            SELECT p.id, p.session_id, p.time_created, p.data,
                   m.data AS message_data,
                   s.directory
            FROM part p
            LEFT JOIN message m ON p.message_id = m.id
            LEFT JOIN session s ON p.session_id = s.id
            WHERE (p.data LIKE '%"type":"tool"%' OR p.data LIKE '%"type":"text"%')
        `;
        const params = [];

        if (sessionId) {
            sql += ' AND p.session_id = ?';
            params.push(sessionId);
        }

        sql += ' ORDER BY p.time_created DESC LIMIT ?';
        params.push(limit);

        let parts;
        try {
            parts = db.prepare(sql).all(...params);
        } catch (_) {
            return [];
        }

        const items = [];
        for (const part of parts) {
            const record = this._buildRecord(part);
            if (!record) continue;

            // 过滤 project_key
            if (filter.project_key && record.project_key !== filter.project_key) continue;

            // 过滤 source
            if (filter.source && filter.source !== this.name) continue;

            items.push(record);
        }

        return items;
    }

    // ─── 启动/停止轮询 ──────────────────────────────────────

    /**
     * 启动轮询
     * @param {number} intervalMs - 轮询间隔（毫秒），默认 5000
     */
    startPolling(intervalMs = POLL_INTERVAL_MS) {
        if (this._pollTimer) return;

        // 立即执行一次
        this._pollOnce();

        this._pollTimer = setInterval(() => this._pollOnce(), intervalMs);

        // 实时监听 opencode.db 变化
        this._startWatcher();
    }

    _startWatcher() {
        if (this._watcher || !fs.existsSync(OPENCODE_DB)) return;
        try {
            this._watchDebounce = null;
            this._watcher = fs.watch(OPENCODE_DB, (eventType) => {
                if (eventType !== 'change') return;
                if (this._watchDebounce) clearTimeout(this._watchDebounce);
                this._watchDebounce = setTimeout(() => {
                    this._pollOnce().catch(() => {});
                }, 2000);
            });
            this._watcher.on('error', () => { this._watcher = null; });
        } catch (_) {}
    }

    /**
     * 停止轮询并关闭数据库
     */
    stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._watcher) {
            try { this._watcher.close(); } catch (_) {}
            this._watcher = null;
        }
        if (this._watchDebounce) {
            clearTimeout(this._watchDebounce);
            this._watchDebounce = null;
        }
        if (this._db) {
            try { this._db.close(); } catch (_) {}
            this._db = null;
        }
    }

}

module.exports = OpenCodeAdapter;
