#!/usr/bin/env node
/**
 * importers/codex.js - Codex JSONL 历史导入器
 *
 * 数据源：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * 解析 Codex rollout 记录（session_meta / event_msg / response_item），
 * 抽取用户消息、助手回复、工具调用（function_call / function_call_output）配对，
 * 转换成统一 timeline 并补进 a-beat.db，让 Codex 历史任务无需 hook 也能展示。
 */

const path = require('path');
const crypto = require('crypto');
const { JsonlImporter } = require('./base');
const BaseAdapter = require('../adapters/base');
const CodexAdapter = require('../adapters/codex');
const { codex: paths } = require('../paths');

const STATES_DIR = path.join(__dirname, '..', 'states');

const codexAdapter = new CodexAdapter();
const baseAdapter = new BaseAdapter();
const MAX_PENDING_TOOLS = 200;

/** 从 rollout 文件名提取会话 UUID：rollout-<ts>-<uuid>.jsonl */
function sessionIdFromFilename(filePath) {
    try {
        const m = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        return m ? m[1] : '';
    } catch {
        return '';
    }
}

function stableMessageId(sessionId, payload, text) {
    if (payload.id) return String(payload.id);
    const basis = `${sessionId}|${payload.role || ''}|${payload.type || ''}|${text}`;
    return `codex-msg-${crypto.createHash('sha1').update(basis).digest('hex')}`;
}

function textFromBlock(block) {
    if (!block) return '';
    if (typeof block === 'string') return block;
    if (Array.isArray(block)) return messageText(block);
    if (typeof block !== 'object') return '';
    for (const key of ['text', 'input_text', 'output_text', 'content', 'refusal']) {
        const value = block[key];
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) return messageText(value);
    }
    return '';
}

/** 从 message.content 提取纯文本（text / input_text / output_text / content / refusal） */
function messageText(blocks) {
    if (typeof blocks === 'string') return blocks;
    if (!Array.isArray(blocks)) return textFromBlock(blocks);
    return blocks
        .map(textFromBlock)
        .filter(Boolean)
        .join('\n\n');
}

/** 解析 "Exit code: N\nWall time: ...\nOutput:\n<content>" 格式的工具输出 */
function parseFunctionOutput(output) {
    const str = String(output || '');
    const exitMatch = str.match(/Exit code:\s*(-?\d+)/i);
    const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
    const outIdx = str.indexOf('Output:');
    let snippet = str;
    if (outIdx >= 0) snippet = str.slice(outIdx + 'Output:'.length).trim();
    return { exitCode, snippet: snippet ? snippet.substring(0, 500) : null, success: exitCode === null ? true : exitCode === 0 };
}

/**
 * 解析一批 Codex JSONL 行
 * @param {string[]} lines
 * @param {Object} ctx { filePath, meta }
 * @returns {{ records: Array, meta: Object }}
 */
function parseCodexLines(lines, ctx = {}) {
    const records = [];
    const meta = ctx.meta && typeof ctx.meta === 'object' ? { ...ctx.meta } : {};
    if (!meta.pendingTools) meta.pendingTools = {};
    const pending = meta.pendingTools;

    for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry !== 'object' || !entry.type) continue;

        const ts = entry.timestamp || '';

        // session 元数据（文件首行通常为 session_meta）
        if (entry.type === 'session_meta' && entry.payload) {
            meta.sessionId = entry.payload.id || meta.sessionId || '';
            meta.cwd = entry.payload.cwd || meta.cwd || '';
            continue;
        }

        const sessionId = meta.sessionId || sessionIdFromFilename(ctx.filePath || '');
        if (!sessionId) continue;
        const cwd = meta.cwd || process.cwd();
        const projectKey = baseAdapter.getProjectKey(cwd);

        if (entry.type !== 'response_item' || !entry.payload) continue;
        const p = entry.payload;

        if (p.type === 'message') {
            const text = messageText(p.content).trim();
            if (!text) continue;
            // 跳过自动注入的 developer 指令与环境上下文
            if (p.role === 'developer') continue;
            if (text.startsWith('<environment_context') || text.startsWith('<permissions instructions')) continue;
            if (p.role === 'user') {
                records.push({ session_id: sessionId, project_key: projectKey, cwd, ts, role: 'user', content: text, tool_use_id: stableMessageId(sessionId, p, text) });
            } else if (p.role === 'assistant') {
                records.push({ session_id: sessionId, project_key: projectKey, cwd, ts, role: 'assistant', content: text, tool_use_id: stableMessageId(sessionId, p, text) });
            }
        } else if (p.type === 'function_call') {
            // 登记待配对的工具调用
            let args = {};
            try { args = JSON.parse(p.arguments || '{}'); } catch { args = {}; }
            pending[p.call_id] = { name: p.name || '', args, ts };
            const keys = Object.keys(pending);
            while (keys.length > MAX_PENDING_TOOLS) {
                delete pending[keys[0]];
                keys.shift();
            }
        } else if (p.type === 'function_call_output') {
            const toolUse = pending[p.call_id];
            const text = String(p.output || '');
            if (toolUse) {
                const callTs = toolUse.ts ? new Date(toolUse.ts).getTime() : 0;
                const resTs = ts ? new Date(ts).getTime() : 0;
                const durationMs = callTs && resTs && resTs >= callTs ? Math.round((resTs - callTs) / 1000) : null;
                const { exitCode, snippet, success } = parseFunctionOutput(text);
                records.push({
                    session_id: sessionId,
                    project_key: projectKey,
                    cwd,
                    ts,
                    role: success ? 'tool_result' : 'tool_error',
                    tool_name: toolUse.name || 'unknown',
                    tool_input: codexAdapter.summarizeInput(toolUse.name || '', toolUse.args || {}),
                    success,
                    exit_code: exitCode,
                    duration_ms: durationMs,
                    output_snippet: snippet,
                    error_message: success ? null : (snippet || text.substring(0, 500)),
                    tool_use_id: p.call_id,
                });
                delete pending[p.call_id];
            }
        } else if (p.type === 'web_search_call') {
            // 自包含搜索调用（无独立 output），按成功记录
            const query = p.action?.query || '';
            records.push({
                session_id: sessionId,
                project_key: projectKey,
                cwd,
                ts,
                role: 'tool_result',
                tool_name: 'web_search',
                tool_input: { query: query.substring(0, 200) },
                success: true,
                output_snippet: query ? query.substring(0, 200) : null,
                tool_use_id: `websearch-${p.call_id || `${ts}-${query.length}`}`,
            });
        }
        // event_msg / reasoning 等跳过
    }

    return { records, meta };
}

const stateFile = path.join(STATES_DIR, 'codex-jsonl-state.json');

module.exports = new JsonlImporter({
    source: 'codex',
    rootDir: paths.sessionsDir,
    stateFile,
    parseLines: parseCodexLines,
    parserVersion: 2,
});

// 导出纯函数便于测试
module.exports.parseCodexLines = parseCodexLines;
module.exports.parseFunctionOutput = parseFunctionOutput;
module.exports.sessionIdFromFilename = sessionIdFromFilename;
module.exports.messageText = messageText;
