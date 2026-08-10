#!/usr/bin/env node
/**
 * Cursor 适配器
 * 复用 Claude Code 适配器的核心逻辑（hooks 格式几乎相同）
 * hooks 配置位于 ~/.cursor/hooks.json
 */

const fs = require('fs');
const path = require('path');
const BaseAdapter = require('./base');
const { insertTimeline } = require('../agent-lens-db');

const BASE_DIR = path.join(__dirname, '..');

// Cursor hooks 配置文件路径
const CURSOR_HOOKS_FILE = path.join(
    process.env.HOME || process.env.USERPROFILE || '~',
    '.cursor', 'hooks.json'
);

class CursorAdapter extends BaseAdapter {
    constructor() {
        super();
    }

    get name() {
        return 'cursor';
    }

    /**
     * 获取 Cursor hooks 配置文件路径
     * @returns {string}
     */
    get hooksConfigPath() {
        return CURSOR_HOOKS_FILE;
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

        if (toolName) {
            const stateFile = this.getStateFile(projectKey);
            const state = this.readState(stateFile);
            const preEntry = this.popFromStack(state);

            if (preEntry) {
                callSeq = preEntry.seq;
                parentSeq = preEntry.parent_seq;

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

        // 写入 JSONL 日志
        const logFile = this.getLogFile(projectKey);
        fs.appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf-8');

        // 双写 SQLite（如果数据库存在）
        this._writeToSqlite({
            sessionId: data.session_id || '',
            projectKey,
            toolName,
            ts: record.ts,
            success,
            durationMs,
            error: record.error,
        });

        // 写入 timeline
        insertTimeline({
            source: this.name,
            session_id: data.session_id || '',
            timestamp: record.ts || '',
            seq: callSeq || null,
            role: 'tool_result',
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
        });
    }
}

module.exports = CursorAdapter;
