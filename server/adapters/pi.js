#!/usr/bin/env node
/**
 * Pi 适配器
 * 从 ~/.pi/agent/sessions/ 轮询 JSONL 会话文件，提取工具调用记录
 */

const fs = require('fs');
const path = require('path');
const BaseAdapter = require('./base');

const { pi: { sessionsDir: PI_SESSIONS_DIR } } = require('../paths');
const POLL_INTERVAL_MS = parseInt(process.env.PI_POLL_INTERVAL_MS, 10) || 30 * 60 * 1000;
const POLL_RECORD_LIMIT = parseInt(process.env.PI_POLL_RECORD_LIMIT, 10) || 10000;

class PiAdapter extends BaseAdapter {
    constructor() {
        super();
        this._pollTimer = null;
        this._lastPollTime = 0; // 上次轮询时间（ms timestamp）
    }

    get name() { return 'pi'; }

    async pre(data) { /* no-op: Pi 无 hooks */ }

    async post(data) { /* no-op: Pi 无 hooks */ }

    /**
     * 从 JSONL session 文件中提取工具调用记录
     */
    async getRecords(filter = {}) {
        if (!fs.existsSync(PI_SESSIONS_DIR)) return [];

        const limit = Math.min(parseInt(filter.limit, 10) || 1000, 10000);
        const sessionId = filter.session_id;
        const projectKey = filter.project_key;
        const records = [];

        // 遍历项目目录
        const projectDirs = fs.readdirSync(PI_SESSIONS_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => path.join(PI_SESSIONS_DIR, d.name));

        for (const projDir of projectDirs) {
            const jsonlFiles = fs.readdirSync(projDir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => path.join(projDir, f));

            for (const filePath of jsonlFiles) {
                try {
                    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
                    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
                    let sessionMeta = null;

                    for (const entry of entries) {
                        try {
                            // 提取 session 元数据
                            if (entry.type === 'session') {
                                sessionMeta = entry;
                                continue;
                            }

                            if (entry.type !== 'message' || !entry.message) continue;

                            const role = entry.message.role;
                            const content = Array.isArray(entry.message.content) ? entry.message.content : [];
                            const cwd = sessionMeta?.cwd || process.cwd();
                            const sid = sessionMeta?.id || entry.sessionId || '';
                            const projectKeyForCwd = this.getProjectKey(cwd);
                            const projectNameForCwd = this.getProjectName(cwd);

                            if (sessionId && sid !== sessionId) continue;
                            if (projectKey) {
                                if (projectKeyForCwd !== projectKey) continue;
                            }

                            this.updateProjectsFile(projectKeyForCwd, cwd, projectNameForCwd);

                            if (role === 'user') {
                                records.push({
                                    ts: entry.timestamp || '',
                                    session_id: sid,
                                    project_key: projectKeyForCwd,
                                    project_name: projectNameForCwd,
                                    cwd,
                                    source: this.name,
                                    role: 'user',
                                    content: this._extractText(content),
                                    success: null,
                                });
                                continue;
                            }

                            if (role === 'assistant') {
                                const assistantText = this._extractText(content);
                                if (assistantText) {
                                    records.push({
                                        ts: entry.timestamp || '',
                                        session_id: sid,
                                        project_key: projectKeyForCwd,
                                        project_name: projectNameForCwd,
                                        cwd,
                                        source: this.name,
                                        role: 'assistant',
                                        content: assistantText,
                                        success: null,
                                    });
                                }
                            }

                            // 提取工具调用
                            if (role === 'assistant') {
                                for (const block of content) {
                                    if (block.type !== 'toolCall') continue;

                                    const toolName = block.name || 'unknown';
                                    const args = block.arguments || {};

                                    // 估算耗时：用 timestamp 差值
                                    let durationMs = null;
                                    // 查找对应的 toolResult
                                    const toolResult = entries.find(e =>
                                        e.type === 'message'
                                        && (e.message?.role === 'tool' || e.message?.role === 'toolResult')
                                        && e.message?.toolCallId === block.id
                                    );
                                    if (toolResult && entry.timestamp && toolResult.timestamp) {
                                        durationMs = Math.round((new Date(toolResult.timestamp) - new Date(entry.timestamp)));
                                    }

                                    const record = {
                                        ts: entry.timestamp || '',
                                        session_id: sid,
                                        project_key: projectKeyForCwd,
                                        project_name: projectNameForCwd,
                                        cwd,
                                        tool_name: toolName,
                                        source: this.name,
                                        role: toolResult?.message?.isError ? 'tool_error' : 'tool_result',
                                        input_summary: this._summarizeInput(toolName, args),
                                        success: !toolResult?.message?.isError,
                                        output_snippet: toolResult ? this._extractText(toolResult.message?.content || []) : null,
                                    };

                                    if (durationMs !== null && durationMs >= 0) {
                                        record.duration_ms = durationMs;
                                    }

                                    records.push(record);
                                }
                            }
                        } catch (_) {}
                    }
                } catch (_) {}
            }
        }

        // 按时间倒序，返回最新记录
        records.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
        return records.slice(0, limit);
    }

    _extractText(content) {
        const blocks = Array.isArray(content) ? content : [content];
        return blocks
            .map(block => {
                if (!block) return '';
                if (typeof block === 'string') return block;
                if (block.type === 'text') return block.text || '';
                if (block.type === 'thinking') return block.thinking || '';
                return '';
            })
            .filter(Boolean)
            .join('\n\n');
    }

    _summarizeInput(toolName, input) {
        if (!input || typeof input !== 'object') return {};
        const summary = {};
        if (toolName === 'bash') {
            const cmd = String(input.command || '');
            summary.command = cmd.length > 120 ? cmd.substring(0, 120) + '…' : cmd;
        } else if (['read', 'write', 'edit'].includes(toolName)) {
            summary.file_path = input.path || '';
        } else {
            summary.keys = Object.keys(input).slice(0, 8);
        }
        return summary;
    }

    startPolling(intervalMs = POLL_INTERVAL_MS) {
        if (this._pollTimer) return;
        this._pollOnce();
        this._pollTimer = setInterval(() => this._pollOnce(), intervalMs);
    }

    async _pollOnce() {
        const now = Date.now();
        const records = await this.getRecords({ limit: POLL_RECORD_LIMIT });

        // 只处理新记录（通过 timestamp 水位线）
        const newRecords = records.filter(r => {
            const ts = new Date(r.ts).getTime();
            return ts > this._lastPollTime;
        });

        if (newRecords.length > 0) {
            this._lastPollTime = now;
            // 聚合写入 agent-lens.db
            for (const record of newRecords) {
                this._aggregateToDb(record);
            }
            this._upsertSessions(newRecords);
        }
    }

    _upsertSessions(records) {
        try {
            const agentLensDb = require('../agent-lens-db');
            const sessions = new Map();
            for (const record of records) {
                if (!record.session_id) continue;
                const isTool = record.role === 'tool_result' || record.role === 'tool_error' || record.tool_name;
                if (!sessions.has(record.session_id)) {
                    sessions.set(record.session_id, {
                        session_id: record.session_id,
                        project_key: record.project_key || '',
                        source: 'pi',
                        start_time: record.ts || '',
                        end_time: record.ts || '',
                        tool_count: 0,
                        error_count: 0,
                        total_duration_ms: 0,
                    });
                }
                const session = sessions.get(record.session_id);
                if (record.ts && (!session.start_time || record.ts < session.start_time)) session.start_time = record.ts;
                if (record.ts && (!session.end_time || record.ts > session.end_time)) session.end_time = record.ts;
                if (isTool) {
                    session.tool_count += 1;
                    if (!record.success) session.error_count += 1;
                    session.total_duration_ms += record.duration_ms || 0;
                }
            }
            for (const session of sessions.values()) {
                agentLensDb.upsertSession(session);
            }
        } catch (_) {}
    }

    _aggregateToDb(record) {
        try {
            const agentLensDb = require('../agent-lens-db');
            const date = (record.ts || '').slice(0, 10);
            const isTool = record.role === 'tool_result' || record.role === 'tool_error' || record.tool_name;
            if (isTool) {
                agentLensDb.updateDailyStats(date, 'pi', record.tool_name, 1, record.success ? 0 : 1, record.duration_ms || 0);
            }
            // 写入 timeline 表，让前端能展开查看调用详情
            agentLensDb.insertTimeline({
                source: 'pi',
                session_id: record.session_id,
                timestamp: record.ts || '',
                seq: null,
                role: record.role || (record.success === false ? 'tool_error' : 'tool_result'),
                tool_name: record.tool_name || null,
                content: record.content || null,
                tool_input: record.input_summary ? JSON.stringify(record.input_summary) : null,
                success: record.success == null ? null : (record.success ? 1 : 0),
                exit_code: null,
                duration_ms: record.duration_ms ?? null,
                output_snippet: record.output_snippet || null,
                error_message: record.success === false ? (record.output_snippet || null) : null,
                error_type: null,
                error_detail: null,
                project_key: record.project_key || null,
                parent_seq: null,
            });
        } catch (_) {}
    }

    stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }
}

module.exports = PiAdapter;
