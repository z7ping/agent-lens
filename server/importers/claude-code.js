#!/usr/bin/env node
/**
 * importers/claude-code.js - Claude Code JSONL 历史导入器
 *
 * 数据源：~/.claude/projects/ 下所有会话 jsonl
 * 解析 Claude Code 自己的会话记录（user / assistant / tool_use / tool_result），
 * 转换成统一 timeline 并补进 a-beat.db，让历史任务无需 hook 也能展示。
 */

const path = require('path');
const { JsonlImporter } = require('./base');
const BaseAdapter = require('../adapters/base');
const ClaudeCodeAdapter = require('../adapters/claude-code');
const { claudeCode: paths } = require('../paths');

const STATES_DIR = path.join(__dirname, '..', 'states');

const ccAdapter = new ClaudeCodeAdapter();
const baseAdapter = new BaseAdapter();
// 每文件最多保留的待配对 tool_use（防止超大文件内存膨胀）
const MAX_PENDING_TOOLS = 200;

/** 从 content（string 或 block 数组）提取纯文本 */
function extractText(content) {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
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

/**
 * 解析一批 Claude Code JSONL 行
 * @param {string[]} lines
 * @param {Object} ctx { filePath, meta }
 * @returns {{ records: Array, meta: Object }}
 */
function parseClaudeLines(lines, ctx = {}) {
    const records = [];
    const meta = ctx.meta && typeof ctx.meta === 'object' ? { ...ctx.meta } : {};
    if (!meta.pendingTools) meta.pendingTools = {};
    const pending = meta.pendingTools;

    for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry !== 'object' || !entry.type) continue;

        const sessionId = entry.sessionId || entry.session_id || '';
        if (!sessionId) continue;
        const ts = entry.timestamp || '';
        if (!ts) continue;

        if (entry.cwd) meta.cwd = entry.cwd;
        const cwd = entry.cwd || meta.cwd || process.cwd();
        const projectKey = baseAdapter.getProjectKey(cwd);

        if (entry.type === 'user') {
            const content = entry.message?.content;
            if (typeof content === 'string') {
                const text = content.trim();
                if (text) {
                    records.push({ session_id: sessionId, project_key: projectKey, cwd, ts, role: 'user', content: text.substring(0, 2000) });
                }
            } else if (Array.isArray(content)) {
                // user 消息中的 tool_result 块 → 配对成工具记录
                for (const block of content) {
                    if (!block || block.type !== 'tool_result') continue;
                    const toolUseId = block.tool_use_id;
                    const toolUse = pending[toolUseId];
                    const text = extractText(block.content).trim();
                    const isError = block.is_error === true || block.is_error === 'true';
                    if (toolUse) {
                        const toolTs = toolUse.ts ? new Date(toolUse.ts).getTime() : 0;
                        const resTs = ts ? new Date(ts).getTime() : 0;
                        const durationMs = toolTs && resTs && resTs >= toolTs ? Math.round(resTs - toolTs) : null;
                        records.push({
                            session_id: sessionId,
                            project_key: projectKey,
                            cwd,
                            ts,
                            role: isError ? 'tool_error' : 'tool_result',
                            tool_name: toolUse.name || 'unknown',
                            tool_input: ccAdapter.summarizeInput(toolUse.name || '', toolUse.input || {}),
                            success: !isError,
                            duration_ms: durationMs,
                            output_snippet: text ? text.substring(0, 500) : null,
                            error_message: isError && text ? text.substring(0, 500) : null,
                            tool_use_id: toolUseId,
                        });
                        delete pending[toolUseId];
                    } else {
                        // 无法配对的 tool_result（缺 tool_use）→ 丢弃，避免未知工具名污染统计
                    }
                }
            }
        } else if (entry.type === 'assistant') {
            const content = entry.message?.content;
            if (Array.isArray(content)) {
                let assistantText = '';
                for (const block of content) {
                    if (!block) continue;
                    if (block.type === 'tool_use') {
                        // 登记待配对的工具调用
                        pending[block.id] = { name: block.name || '', input: block.input || {}, ts };
                        // 限制大小，淘汰最旧的
                        const keys = Object.keys(pending);
                        while (keys.length > MAX_PENDING_TOOLS) {
                            delete pending[keys[0]];
                            keys.shift();
                        }
                    } else if (block.type === 'text') {
                        assistantText += (block.text || '') + '\n\n';
                    }
                }
                if (assistantText.trim()) {
                    records.push({ session_id: sessionId, project_key: projectKey, cwd, ts, role: 'assistant', content: assistantText.trim().substring(0, 2000) });
                }
            }
        }
        // 其他类型（system / summary / attachment / compact 等）跳过
    }

    return { records, meta };
}

const stateFile = path.join(STATES_DIR, 'claude-jsonl-state.json');

module.exports = new JsonlImporter({
    source: 'claude-code',
    rootDir: paths.projectsDir,
    stateFile,
    parseLines: parseClaudeLines,
});

// 导出纯函数便于测试
module.exports.parseClaudeLines = parseClaudeLines;
module.exports.extractText = extractText;
