#!/usr/bin/env node
/**
 * Codex 适配器
 * 通过 ~/.codex/hooks.json 配置 PreToolUse/PostToolUse 钩子
 * 从 stdin 接收 JSON 数据，转换为统一格式
 */

const fs = require('fs');
const path = require('path');
const BaseAdapter = require('./base');
const { getDb, insertTimeline, recomputeSession } = require('../agent-lens-db');
const { buildCodexLifecycleRecord } = require('../codex-lifecycle');
const { discoverCodexInstructionFiles } = require('../codex-context');
const { makeEventId, stableHash } = require('../event-model');
const { captureConfigValue } = require('../privacy');

const HOME_DIR = require('os').homedir();
const CODEX_DIR = path.join(HOME_DIR, '.codex');

class CodexAdapter extends BaseAdapter {
    get name() {
        return 'codex';
    }

    // pre() 继承自 base.js，覆盖 tool_name 字段名
    async pre(data) {
        const enriched = data && !data.agent_id && !data.subagent_id
            ? { ...data, missing_reason: 'Codex Tool Hook 未提供当前 Agent 标识；不推断子 Agent 归属' }
            : data;
        return super.pre(enriched, {
            toolNameField: 'tool_name',
            cwdFields: ['cwd', 'working_directory', 'workdir'],
            inferParentFromStack: false,
        });
    }

    findLifecycleParent(record) {
        const db = getDb();
        if (!db) return null;
        if (record.event_type === 'agent_stop' && record.agent_id) {
            return db.prepare(`
                SELECT event_id FROM timeline
                WHERE source = 'codex' AND session_id = ? AND event_type = 'agent_start'
                  AND agent_id = ? AND (? IS NULL OR turn_id = ?)
                ORDER BY timestamp DESC, id DESC LIMIT 1
            `).get(record.session_id, record.agent_id, record.turn_id, record.turn_id)?.event_id || null;
        }
        if (record.event_type === 'compact_end' && record.turn_id) {
            return db.prepare(`
                SELECT event_id FROM timeline
                WHERE source = 'codex' AND session_id = ? AND turn_id = ?
                  AND event_type = 'compact_start'
                ORDER BY timestamp DESC, id DESC LIMIT 1
            `).get(record.session_id, record.turn_id)?.event_id || null;
        }
        return null;
    }

    async lifecycle(data) {
        if (!data || typeof data !== 'object') return null;
        const cwd = data.cwd || data.working_directory || data.workdir || process.cwd();
        const projectKey = this.getProjectKey(cwd);
        const projectName = this.getProjectName(cwd);
        this.updateProjectsFile(projectKey, cwd, projectName);

        const record = buildCodexLifecycleRecord(data, {
            projectKey,
            summarizeToolInput: (toolName, input) => this.summarizeInput(toolName, input),
        });
        if (!record) return null;
        record.event_id = makeEventId(record);
        record.parent_event_id = this.findLifecycleParent(record);
        const info = insertTimeline(record);
        const contextEvents = [];
        if (record.event_type === 'session_start') {
            for (const entry of discoverCodexInstructionFiles(cwd)) {
                const capturedContent = captureConfigValue(entry.content);
                const capturedPath = captureConfigValue(entry.path, process.env, { maxText: 2000 });
                const contextRecord = {
                    source: 'codex',
                    source_event_id: `context:${stableHash(`${record.event_id}|${entry.path}|${entry.modified_at}|${entry.bytes}`).slice(0, 32)}`,
                    session_id: record.session_id,
                    timestamp: record.timestamp,
                    event_type: 'context_discovery',
                    role: 'context_discovery',
                    parent_event_id: record.event_id,
                    content: capturedContent.value,
                    project_key: projectKey,
                    attributes_json: {
                        scope: entry.scope,
                        file_name: entry.file_name,
                        path: capturedPath.value,
                        bytes: entry.bytes,
                        truncated: entry.truncated,
                        precedence: entry.precedence,
                    },
                    capture_method: 'static_scan',
                    visibility: 'discovered',
                    confidence: 'partial',
                    missing_reason: '当前环境静态发现，不能证明历史 Turn 实际加载了该内容',
                    redaction_applied: capturedContent.redactionApplied || capturedPath.redactionApplied ? 1 : 0,
                    capture_policy: `config:${capturedContent.capturePolicy}`,
                };
                contextEvents.push({ record: contextRecord, info: insertTimeline(contextRecord) });
            }
        }
        recomputeSession('codex', record.session_id, projectKey);
        return { record, info, contextEvents };
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

        if (toolName === 'shell' || toolName === 'bash' || toolName === 'terminal') {
            const cmd = String(toolInput.command || toolInput.cmd || '');
            summary.command = cmd.length > 120 ? cmd.substring(0, 120) + '…' : cmd;
            summary.description = toolInput.description || '';
        } else if (['read', 'write', 'edit', 'file_read', 'file_write', 'file_edit'].includes(toolName)) {
            summary.file_path = toolInput.file_path || toolInput.path || '';
            if (['edit', 'file_edit'].includes(toolName)) {
                summary.old_len = (toolInput.old_string || toolInput.old || '').length;
                summary.new_len = (toolInput.new_string || toolInput.new || '').length;
            }
        } else if (toolName === 'web_search' || toolName === 'search') {
            summary.query = String(toolInput.query || toolInput.search || '').substring(0, 100);
        } else if (toolName === 'computer' || toolName === 'browser') {
            summary.action = toolInput.action || '';
            if (toolInput.url) {
                summary.url = String(toolInput.url).substring(0, 100);
            }
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

        const cwd = data.cwd || data.working_directory || data.workdir || process.cwd();
        const projectKey = this.getProjectKey(cwd);
        const projectName = this.getProjectName(cwd);

        // 更新项目列表
        this.updateProjectsFile(projectKey, cwd, projectName);

        let response = data.tool_response || data.output || data.result;
        if (Array.isArray(response)) {
            response = response[0] || {};
        }

        const toolName = data.tool_name || data.name || data.tool || '';
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
            const preEntry = this.popFromStack(state, callId);

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
            }

            this.writeState(stateFile, state);
        }

        // 组装记录
        const record = {
            ts: new Date().toISOString(),
            session_id: data.session_id || data.conversation_id || '',
            project_key: projectKey,
            project_name: projectName,
            tool_name: toolName,
            source: this.name,
            input_summary: this.summarizeInput(toolName, data.tool_input || data.input || {}),
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

        // 写入 timeline
        const info = insertTimeline({
            source: this.name,
            session_id: data.session_id || '',
            timestamp: record.ts || '',
            source_sequence: callSeq,
            seq: callSeq || null,
            event_type: success ? 'tool_result' : 'tool_error',
            role: success ? 'tool_result' : 'tool_error',
            call_id: callId,
            tool_use_id: callId,
            parent_event_id: parentEventId,
            tool_name: toolName || null,
            content: null,
            tool_input: record.input_summary ? JSON.stringify(record.input_summary) : null,
            success: success ? 1 : 0,
            exit_code: null,
            duration_ms: durationMs ?? null,
            output_snippet: typeof response === 'string' ? response.substring(0, 2000) : JSON.stringify(response || {}).substring(0, 2000),
            error_message: record.error || null,
            error_type: null,
            error_detail: null,
            project_key: projectKey || null,
            parent_seq: parentSeq || null,
            agent_id: data.agent_id || data.subagent_id || null,
            turn_id: data.turn_id || null,
            capture_method: 'runtime_hook',
            visibility: 'captured',
            confidence: 'confirmed',
            missing_reason: (!data.agent_id && !data.subagent_id)
                ? 'Codex Tool Hook 未提供当前 Agent 标识；不推断子 Agent 归属'
                : null,
        });
        this._writeToSqlite({
            sessionId: data.session_id || '', projectKey, toolName, ts: record.ts,
            success, durationMs, error: record.error, inserted: info.changes > 0,
        });
    }
}

module.exports = CodexAdapter;
