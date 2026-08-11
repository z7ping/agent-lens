#!/usr/bin/env node
/**
 * Claude Code 适配器
 * 复用现有 hooks/prelog.js + hooks/log.js 的核心逻辑
 * 支持 JSONL 轮询聚合到 agent-lens.db
 */

const fs = require('fs');
const path = require('path');
const BaseAdapter = require('./base');
const { insertTimeline } = require('../agent-lens-db');
const { ensureRuntimeDirs, getRuntimePaths } = require('../runtime-paths');

const BASE_DIR = path.join(__dirname, '..');
const RUNTIME_PATHS = getRuntimePaths({ baseDir: BASE_DIR });
ensureRuntimeDirs(RUNTIME_PATHS);
const LOGS_DIR = RUNTIME_PATHS.logsDir;
// 可配置：轮询间隔（毫秒），默认 30 分钟
const POLL_INTERVAL_MS = parseInt(process.env.CLAUDE_CODE_POLL_INTERVAL_MS, 10) || 30 * 60 * 1000;
// 轮询状态文件：记录每个 JSONL 文件已处理的行数
const POLL_STATE_FILE = path.join(RUNTIME_PATHS.stateDir, 'claude-code-poll-state.json');

class ClaudeCodeAdapter extends BaseAdapter {
    constructor() {
        super();
        this._pollTimer = null;
    }

    get name() {
        return 'claude-code';
    }

    // ─── PreToolUse ────────────────────────────────────────

    /**
     * 处理 PreToolUse 事件：记录 tool_use 到 timeline
     */
    async pre(data) {
        return super.pre(data);
    }

    // ─── PostToolUse ───────────────────────────────────────

    /**
     * 摘要化工具输入
     * @param {string} toolName
     * @param {Object} toolInput
     * @returns {Object}
     */
    summarizeInput(toolName, toolInput) {
        if (!toolInput || typeof toolInput !== 'object') return {};

        const summary = {};

        if (toolName === 'Bash') {
            const cmd = String(toolInput.command || '');
            summary.command = cmd.length > 120 ? cmd.substring(0, 120) + '…' : cmd;
            summary.description = toolInput.description || '';
        } else if (['Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(toolName)) {
            summary.file_path = toolInput.file_path || '';
            if (toolName === 'Edit') {
                summary.old_len = (toolInput.old_string || '').length;
                summary.new_len = (toolInput.new_string || '').length;
            } else if (toolName === 'Grep') {
                summary.pattern = toolInput.pattern || '';
                summary.output_mode = toolInput.output_mode || '';
            } else if (toolName === 'Glob') {
                summary.pattern = toolInput.pattern || '';
            }
        } else if (toolName === 'Skill') {
            summary.skill = toolInput.skill || '';
            if (toolInput.args) {
                const args = String(toolInput.args);
                summary.args = args.length > 100 ? args.substring(0, 100) + '…' : args;
            }
        } else if (toolName === 'Agent') {
            summary.description = toolInput.description || '';
            summary.agent_type = toolInput.agentType || '';
        } else if (toolName.startsWith('mcp__')) {
            const parts = toolName.split('__');
            summary.mcp_server = parts.length > 2 ? parts[1] : '';
            summary.tool = parts.length > 2 ? parts[parts.length - 1] : toolName;
            for (const key of ['query', 'symbol', 'pattern', 'prompt', 'path', 'question']) {
                if (key in toolInput) {
                    const val = String(toolInput[key]);
                    summary[key] = val.length > 100 ? val.substring(0, 100) + '…' : val;
                }
            }
        } else {
            summary.keys = Object.keys(toolInput).slice(0, 8);
        }

        return summary;
    }

    /**
     * 处理 PostToolUse 事件：记录工具调用日志
     * @param {Object} data - 从 stdin 读取的 JSON 数据
     */
    async post(data) {
        if (!data || typeof data !== 'object') return;

        const cwd = data.cwd || data.working_directory || process.cwd();
        const projectKey = this.getProjectKey(cwd);
        const projectName = this.getProjectName(cwd);

        // 更新项目列表
        this.updateProjectsFile(projectKey, cwd, projectName);

        let response = data.tool_response;
        if (Array.isArray(response)) {
            response = response[0] || {};
        }

        const toolName = data.tool_name || '';
        const { success, error: errorMsg } = this.judgeSuccess(response);

        // 读取调用栈，计算耗时和调用链
        let durationMs = data.duration_ms;
        let parentSeq = null;
        let callSeq = null;
        let callId = data.call_id || data.tool_use_id || null;
        let parentEventId = null;

        if (toolName) {
            const stateFile = this.getStateFile(projectKey);
            const state = this.readState(stateFile);
            const preEntry = this.popFromStack(state);

            if (preEntry) {
                callSeq = preEntry.seq;
                parentSeq = preEntry.parent_seq;
                callId = preEntry.call_id || callId;
                parentEventId = preEntry.event_id || null;

                if (durationMs === null || durationMs === undefined) {
                    try {
                        const tsStart = new Date(preEntry.ts_start);
                        const tsNow = new Date();
                        durationMs = Math.round((tsNow - tsStart) * 1000) / 1000;
                    } catch (e) {
                        // 忽略错误
                    }
                }
            } else {
                // 诊断：栈为空时记录警告
                try {
                    const fs = require('fs');
                    const logFile = require('path').join(LOGS_DIR, 'trace_error.log');
                    const msg = `[${new Date().toISOString()}] post: stack empty for tool=${toolName}, project=${projectKey}\n`;
                    fs.appendFileSync(logFile, msg, 'utf-8');
                } catch (_) {}
            }

            this.writeState(stateFile, state);
        }

        // 组装记录
        const record = {
            ts: new Date().toISOString(),
            session_id: data.session_id || '',
            project_key: projectKey,
            project_name: projectName,
            tool_name: toolName,
            source: this.name,
            input_summary: this.summarizeInput(toolName, data.tool_input || {}),
            success: success,
        };

        if (callSeq !== null) {
            record.seq = callSeq;
        }
        if (parentSeq !== null) {
            record.parent_seq = parentSeq;
        }
        if (durationMs !== null && durationMs !== undefined) {
            record.duration_ms = durationMs;
        }
        if (!success && errorMsg) {
            record.error = errorMsg.substring(0, 500).trim();
        }

        this.appendLogRecord(projectKey, record);

        // 写入 timeline 表
        try {
            let outputSnippet = null;
            if (response && typeof response === 'object') {
                const text = response.text || response.content || '';
                if (typeof text === 'string') outputSnippet = text.substring(0, 500);
            }
            const info = insertTimeline({
                source: this.name,
                session_id: data.session_id || '',
                timestamp: record.ts,
                source_sequence: callSeq,
                seq: callSeq,
                event_type: success ? 'tool_result' : 'tool_error',
                role: success ? 'tool_result' : 'tool_error',
                call_id: callId,
                tool_use_id: callId,
                parent_event_id: parentEventId,
                tool_name: toolName || null,
                content: outputSnippet,
                tool_input: data.tool_input || null,
                success: success,
                exit_code: null,
                duration_ms: durationMs,
                output_snippet: outputSnippet,
                error_message: record.error || null,
                project_key: projectKey,
                parent_seq: parentSeq,
                agent_id: data.agent_id || data.subagent_id || null,
                turn_id: data.turn_id || null,
                capture_method: 'runtime_hook',
                visibility: 'captured',
                confidence: 'confirmed',
            });
            this._writeToSqlite({
                sessionId: data.session_id || '', projectKey, toolName, ts: record.ts,
                success, durationMs, error: record.error, inserted: info.changes > 0,
            });
        } catch (_) {}
    }

    // ─── JSONL 轮询聚合 ──────────────────────────────────

    /**
     * 读取轮询状态（每个文件已处理的行数）
     * @returns {Object} { [filename]: processedLineCount }
     */
    _readPollState() {
        try {
            if (fs.existsSync(POLL_STATE_FILE)) {
                return JSON.parse(fs.readFileSync(POLL_STATE_FILE, 'utf-8'));
            }
        } catch (_) {}
        return {};
    }

    /**
     * 写入轮询状态
     * @param {Object} state
     */
    _writePollState(state) {
        try {
            const dir = path.dirname(POLL_STATE_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(POLL_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
        } catch (_) {}
    }

    /**
     * 轮询一次：扫描 JSONL 文件，聚合新记录到 agent-lens.db
     */
    async _pollOnce() {
        if (!fs.existsSync(LOGS_DIR)) return;

        try {
            const agentLensDb = require('../agent-lens-db');
            const pollState = this._readPollState();
            const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.jsonl'));

            for (const file of files) {
                const logFile = path.join(LOGS_DIR, file);
                const content = fs.readFileSync(logFile, 'utf-8');
                const lines = content.split('\n').filter(l => l.trim());
                const totalLines = lines.length;
                const processed = pollState[file] || 0;

                if (processed >= totalLines) continue;

                // 只处理新增行
                const newLines = lines.slice(processed);
                const bySession = new Map();

                for (const line of newLines) {
                    try {
                        const record = JSON.parse(line);
                        // 只聚合 claude-code 来源的记录
                        if (record.source && record.source !== 'claude-code') continue;
                        if (!record.session_id) continue;

                        if (!bySession.has(record.session_id)) {
                            bySession.set(record.session_id, []);
                        }
                        bySession.get(record.session_id).push(record);
                    } catch (_) {}
                }

                for (const [sessionId, records] of bySession) {
                    let totalDuration = 0;
                    let errorCount = 0;
                    let firstTs = null;
                    let lastTs = null;

                    for (const record of records) {
                        totalDuration += record.duration_ms || 0;
                        if (!record.success) errorCount++;

                        const ts = record.ts || '';
                        if (ts) {
                            if (!firstTs || ts < firstTs) firstTs = ts;
                            if (!lastTs || ts > lastTs) lastTs = ts;

                            // 按天统计
                            const date = ts.slice(0, 10);
                            agentLensDb.updateDailyStats(date, 'claude-code', record.tool_name, 1, record.success ? 0 : 1, record.duration_ms || 0);

                            // 错误记录
                            if (!record.success && record.error) {
                                agentLensDb.saveError(ts, sessionId, 'claude-code', record.tool_name, record.error);
                            }

                            // 写入 timeline（轮询兜底）
                            agentLensDb.insertTimeline({
                                source: 'claude-code',
                                session_id: sessionId,
                                timestamp: ts,
                                seq: record.seq || null,
                                role: record.success ? 'tool_result' : 'tool_error',
                                tool_name: record.tool_name || null,
                                content: null,
                                tool_input: typeof record.input_summary === 'string' ? record.input_summary : JSON.stringify(record.input_summary || {}),
                                success: record.success ? 1 : 0,
                                exit_code: null,
                                duration_ms: record.duration_ms || 0,
                                output_snippet: null,
                                error_message: record.error || null,
                                error_type: null,
                                error_detail: null,
                                project_key: record.project_key || '',
                                parent_seq: record.parent_seq || null,
                            });
                        }
                    }

                    // session 摘要（累加 total_duration_ms）
                    const projectKey = records[0].project_key || '';
                    const existingDuration = agentLensDb.getSessionDuration(this.name, sessionId);
                    agentLensDb.upsertSession({
                        session_id: sessionId,
                        project_key: projectKey,
                        source: 'claude-code',
                        start_time: firstTs || '',
                        end_time: lastTs || '',
                        tool_count: records.length,
                        error_count: errorCount,
                        total_duration_ms: existingDuration + totalDuration,
                    });
                }

                pollState[file] = totalLines;
            }

            this._writePollState(pollState);
        } catch (e) {
            this.logError(e, 'claude-code:poll');
        }
    }

    /**
     * 启动 JSONL 轮询
     * @param {number} intervalMs - 轮询间隔（毫秒）
     */
    startPolling(intervalMs = POLL_INTERVAL_MS) {
        if (this._pollTimer) return;

        // 立即执行一次
        this._pollOnce();

        this._pollTimer = setInterval(() => this._pollOnce(), intervalMs);
    }

    /**
     * 获取会话列表（从 JSONL 文件聚合）
     * @param {Object} filter - 过滤条件
     * @returns {Array} 会话摘要列表
     */
    async getSessions(filter = {}) {
        const limit = Math.min(parseInt(filter.limit, 10) || 50, 200);
        const logsDir = LOGS_DIR;

        if (!fs.existsSync(logsDir)) return [];

        // 按 session 聚合记录
        const sessionMap = new Map();

        const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(logsDir, file), 'utf-8');
                const lines = content.split('\n').filter(l => l.trim());

                for (const line of lines) {
                    try {
                        const record = JSON.parse(line);
                        if (record.source !== 'claude-code') continue;
                        if (!record.session_id) continue;

                        // 过滤 project_key
                        if (filter.project_key && record.project_key !== filter.project_key) continue;

                        if (!sessionMap.has(record.session_id)) {
                            sessionMap.set(record.session_id, {
                                session_id: record.session_id,
                                project_key: record.project_key || '',
                                source: 'claude-code',
                                calls: [],
                                first_ts: record.ts,
                                last_ts: record.ts,
                            });
                        }

                        const session = sessionMap.get(record.session_id);
                        session.calls.push(record);
                        if (record.ts < session.first_ts) session.first_ts = record.ts;
                        if (record.ts > session.last_ts) session.last_ts = record.ts;
                    } catch (_) {}
                }
            } catch (_) {}
        }

        // 转换为统一格式
        const sessions = [];
        for (const [sessionId, data] of sessionMap) {
            let totalDuration = 0;
            let errorCount = 0;

            for (const call of data.calls) {
                totalDuration += call.duration_ms || 0;
                if (!call.success) errorCount++;
            }

            sessions.push({
                session_id: sessionId,
                project_key: data.project_key,
                source: 'claude-code',
                start_time: data.firstTs || data.first_ts || '',
                end_time: data.lastTs || data.last_ts || '',
                tool_count: data.calls.length,
                error_count: errorCount,
                total_duration_ms: totalDuration,
            });
        }

        // 按时间倒序排序
        sessions.sort((a, b) => (b.start_time || '').localeCompare(a.start_time || ''));

        return sessions.slice(0, limit);
    }

    /**
     * 停止轮询
     */
    stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }
}

module.exports = ClaudeCodeAdapter;
