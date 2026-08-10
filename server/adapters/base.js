#!/usr/bin/env node
/**
 * 适配器基类
 * 所有工具适配器继承此类并实现 pre() 和 post() 方法
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureRuntimeDirs, getRuntimePaths } = require('../runtime-paths');

const BASE_DIR = path.join(__dirname, '..');
const RUNTIME_PATHS = getRuntimePaths({ baseDir: BASE_DIR });
ensureRuntimeDirs(RUNTIME_PATHS);
const STATES_DIR = RUNTIME_PATHS.stateDir;
const LOGS_DIR = RUNTIME_PATHS.logsDir;
const PROJECTS_FILE = RUNTIME_PATHS.projectsFile;

class BaseAdapter {
    /**
     * 适配器名称（子类必须覆盖）
     * @returns {string}
     */
    get name() {
        throw new Error('Subclass must implement getter "name"');
    }

    /**
     * 处理 PostToolUse 事件
     * @param {Object} data - 从 stdin 读取的 JSON 数据
     */
    async post(data) {
        throw new Error('Subclass must implement post()');
    }

    /**
     * 获取工具调用记录
     * @param {Object} filter - 过滤条件
     * @returns {Array} 统一格式的调用记录
     */
    async getRecords(filter) {
        throw new Error('Subclass must implement getRecords()');
    }

    // ─── 共享工具方法 ──────────────────────────────────────

    /**
     * 根据工作目录生成项目键
     * @param {string} cwd
     * @returns {string} MD5 前 12 位
     */
    getProjectKey(cwd) {
        if (!cwd) cwd = process.cwd();
        return crypto.createHash('md5').update(cwd).digest('hex').substring(0, 12);
    }

    /**
     * 获取项目名称
     * @param {string} cwd
     * @returns {string}
     */
    getProjectName(cwd) {
        if (!cwd) cwd = process.cwd();
        return path.basename(cwd);
    }

    /**
     * 获取状态文件路径
     * @param {string} projectKey
     * @returns {string}
     */
    getStateFile(projectKey) {
        return path.join(STATES_DIR, `${projectKey}.json`);
    }

    /**
     * 获取日志文件路径
     * @param {string} projectKey
     * @returns {string}
     */
    getLogFile(projectKey) {
        return path.join(LOGS_DIR, `${projectKey}.jsonl`);
    }

    /**
     * 读取调用栈状态
     * @param {string} stateFile
     * @returns {Object}
     */
    readState(stateFile) {
        if (fs.existsSync(stateFile)) {
            try {
                const content = fs.readFileSync(stateFile, 'utf-8').trim();
                if (content) {
                    return JSON.parse(content);
                }
            } catch (e) {
                // 忽略错误
            }
        }
        return { seq: 0, stack: [] };
    }

    /**
     * 写入调用栈状态
     * @param {string} stateFile
     * @param {Object} state
     */
    writeState(stateFile, state) {
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
    }

    /**
     * 更新项目注册表
     * @param {string} projectKey
     * @param {string} cwd
     * @param {string} projectName
     */
    updateProjectsFile(projectKey, cwd, projectName) {
        let projects = {};
        if (fs.existsSync(PROJECTS_FILE)) {
            try {
                const content = fs.readFileSync(PROJECTS_FILE, 'utf-8').trim();
                if (content) {
                    projects = JSON.parse(content);
                }
            } catch (e) {
                projects = {};
            }
        }

        projects[projectKey] = {
            cwd: cwd,
            name: projectName,
            last_seen: new Date().toISOString()
        };

        fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf-8');
    }

    /**
     * 截断过长的值
     * @param {*} obj
     * @param {number} maxLen
     * @returns {*}
     */
    truncate(obj, maxLen = 200) {
        if (typeof obj === 'string') {
            return obj.length > maxLen ? obj.substring(0, maxLen) + '…' : obj;
        }
        if (Array.isArray(obj)) {
            return obj.slice(0, 10).map(item => this.truncate(item, maxLen));
        }
        if (obj && typeof obj === 'object') {
            const result = {};
            for (const [key, value] of Object.entries(obj)) {
                result[key] = this.truncate(value, maxLen);
            }
            return result;
        }
        return obj;
    }

    /**
     * 从工具响应中提取错误信息
     * @param {*} response
     * @returns {string|null}
     */
    extractError(response) {
        if (typeof response === 'string') {
            return response.trim() ? response.substring(0, 300) : null;
        }
        if (response && typeof response === 'object') {
            for (const key of ['error', 'message', 'stderr', 'errorMessage', 'error_message']) {
                const val = response[key];
                if (val) {
                    const str = String(val);
                    if (str && str !== 'None' && str !== 'false' && str !== 'True') {
                        return str.substring(0, 300);
                    }
                }
            }
            return null;
        }
        if (Array.isArray(response)) {
            for (const item of response) {
                if (item && typeof item === 'object') {
                    const err = this.extractError(item);
                    if (err) return err;
                }
            }
        }
        return null;
    }

    /**
     * 从调用栈中弹出栈顶条目（LIFO 严格后进先出）
     * @param {Object} state
     * @returns {Object|null}
     */
    popFromStack(state) {
        if (state.stack.length === 0) return null;
        return state.stack.pop();
    }

    /**
     * 处理 PreToolUse 事件（通用实现）
     * @param {Object} data - 从 stdin 读取的 JSON 数据
     * @param {Object} [opts] - 可选覆盖 { toolNameField, cwdFields }
     */
    async pre(data, opts = {}) {
        if (!data || typeof data !== 'object') return;

        const toolNameField = opts.toolNameField || 'tool_name';
        const toolName = data[toolNameField];
        if (!toolName) return;

        const cwdFields = opts.cwdFields || ['cwd', 'working_directory'];
        let cwd;
        for (const f of cwdFields) {
            if (data[f]) { cwd = data[f]; break; }
        }
        cwd = cwd || process.cwd();

        const projectKey = this.getProjectKey(cwd);
        const stateFile = this.getStateFile(projectKey);

        const state = this.readState(stateFile);

        // 清理残留的旧条目（超过 30 分钟未消费的视为残留）
        const STALE_THRESHOLD_MS = 30 * 60 * 1000;
        const now = Date.now();
        if (state.stack.length > 0) {
            const staleCount = state.stack.filter(entry => {
                try {
                    return (now - new Date(entry.ts_start).getTime()) > STALE_THRESHOLD_MS;
                } catch (_) { return false; }
            }).length;
            if (staleCount > 0) {
                state.stack = state.stack.filter(entry => {
                    try {
                        return (now - new Date(entry.ts_start).getTime()) <= STALE_THRESHOLD_MS;
                    } catch (_) { return true; }
                });
            }
        }

        state.seq += 1;
        const seq = state.seq;

        const parentSeq = state.stack.length > 0 ? state.stack[state.stack.length - 1].seq : null;

        const entry = {
            seq: seq,
            tool_name: toolName,
            ts_start: new Date().toISOString(),
            parent_seq: parentSeq,
            cwd: cwd
        };
        state.stack.push(entry);

        this.writeState(stateFile, state);
    }

    /**
     * 判断工具调用是否成功（通用实现：仅使用 exit_code）
     * @param {*} response
     * @returns {{ success: boolean, error: string|null }}
     */
    judgeSuccess(response) {
        let success = true;
        let errorMsg = null;

        if (response && typeof response === 'object') {
            success = response.success !== false;
            const exitCode = response.exit_code ?? response.exitCode;
            if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
                success = false;
            }
            if (!success) {
                errorMsg = response.stderr || response.error || response.output || this.extractError(response);
                if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
                    errorMsg = `Exit code ${exitCode}` + (errorMsg ? `: ${errorMsg}` : '');
                }
            }
        }

        return { success, error: errorMsg };
    }

    /**
     * 获取工具调用记录（从 JSONL 文件读取）
     * @param {Object} filter - 过滤条件
     * @param {string} filter.project_key
     * @param {string} filter.session_id
     * @param {number} filter.limit
     * @param {string} [filter.source] - 仅读取指定 source 的记录（用于有 source 字段的适配器）
     * @returns {Array}
     */
    async getRecords(filter = {}) {
        const { project_key, session_id, limit = 100, source } = filter;
        const filterSource = source || this.name;
        const records = [];
        const logsDir = LOGS_DIR;

        const processLine = (line) => {
            try {
                const record = JSON.parse(line);
                if (filterSource && record.source !== filterSource) return;
                if (session_id && record.session_id !== session_id) return;
                records.push(record);
            } catch (_) {}
        };

        if (project_key) {
            const logFile = this.getLogFile(project_key);
            if (fs.existsSync(logFile)) {
                const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
                lines.forEach(processLine);
            }
        } else {
            if (fs.existsSync(logsDir)) {
                const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
                for (const file of files) {
                    const logFile = path.join(logsDir, file);
                    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean);
                    lines.forEach(processLine);
                }
            }
        }

        return records.slice(-limit);
    }

    /**
     * 双写 SQLite 统计摘要到 agent-lens.db（共享实现）
     * @param {Object} opts
     * @param {string} opts.sessionId
     * @param {string} opts.projectKey
     * @param {string} opts.toolName
     * @param {string} opts.ts
     * @param {boolean} opts.success
     * @param {number} [opts.durationMs]
     * @param {string} [opts.error]
     */
    _writeToSqlite({ sessionId, projectKey, toolName, ts, success, durationMs, error }) {
        try {
            const agentLensDb = require('../agent-lens-db');
            const date = ts ? ts.slice(0, 10) : '';

            // 按天统计
            agentLensDb.updateDailyStats(date, this.name, toolName, 1, success ? 0 : 1, durationMs || 0);

            // 错误记录
            if (!success && error) {
                agentLensDb.saveError(ts, sessionId || '', this.name, toolName, error);
            }

            // session 摘要（累加 total_duration_ms）
            if (sessionId) {
                const existingDuration = agentLensDb.getSessionDuration(sessionId);
                agentLensDb.upsertSession({
                    session_id: sessionId,
                    project_key: projectKey,
                    source: this.name,
                    start_time: ts,
                    end_time: ts,
                    tool_count: 1,
                    error_count: success ? 0 : 1,
                    total_duration_ms: existingDuration + (durationMs || 0),
                });
            }
        } catch (_) {}
    }

    /**
     * 记录错误日志
     * @param {Error|string} e
     * @param {string} source - 来源标识
     */
    logError(e, source = 'adapter') {
        try {
            const logFile = path.join(LOGS_DIR, 'trace_error.log');
            const msg = `[${new Date().toISOString()}] ${source}: ${e.message || e}\n`;
            fs.appendFileSync(logFile, msg, 'utf-8');
        } catch (_) {
            // 写日志本身失败时静默
        }
    }

    /**
     * 错误自动分类
     * @param {string} errorMessage
     * @returns {{ error_type: string, error_detail: object|null }}
     */
    classifyError(errorMessage) {
        if (!errorMessage) return { error_type: 'unknown', error_detail: null };

        const msg = String(errorMessage).toLowerCase();

        if (msg.includes('cmd.exe') || msg.includes('powershell') || msg.includes('.exe') || msg.includes('c:\\\\')) {
            return { error_type: 'windows_command', error_detail: { full_error: errorMessage.substring(0, 500) } };
        }
        if (msg.includes('no such file') || msg.includes('not found') || msg.includes('does not exist') || msg.includes('enoent')) {
            return { error_type: 'path_not_found', error_detail: { full_error: errorMessage.substring(0, 500) } };
        }
        if (msg.includes('permission denied') || msg.includes('eacces') || msg.includes('permission')) {
            return { error_type: 'permission', error_detail: { full_error: errorMessage.substring(0, 500) } };
        }
        if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('timed out')) {
            return { error_type: 'timeout', error_detail: { full_error: errorMessage.substring(0, 500) } };
        }
        if (msg.includes('syntaxerror') || msg.includes('unexpected token') || msg.includes('syntax error')) {
            return { error_type: 'syntax', error_detail: { full_error: errorMessage.substring(0, 500) } };
        }

        return { error_type: 'unknown', error_detail: { full_error: errorMessage.substring(0, 500) } };
    }
}

module.exports = BaseAdapter;
module.exports.BASE_DIR = BASE_DIR;
