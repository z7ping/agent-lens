#!/usr/bin/env node
/**
 * PostToolUse hook: 记录工具调用日志（含耗时、调用链）
 * 由 prelog.js (PreToolUse) + log.js (PostToolUse) 配合实现耗时追踪
 *
 * 委托给适配器处理具体逻辑，本文件负责：
 * 1. 读取 stdin
 * 2. 根据数据格式分发给对应适配器的 post() 方法
 */

const path = require('path');
const fs = require('fs');
const { getDefaultAdapter, getAdapter } = require('../adapters');
const { ensureRuntimeDirs, getRuntimePaths } = require('../runtime-paths');

const BASE_DIR = path.join(__dirname, '..');
const RUNTIME_PATHS = getRuntimePaths({ baseDir: BASE_DIR });
ensureRuntimeDirs(RUNTIME_PATHS);

// Codex 数据有 hook_event_name 字段，Claude Code 没有
function pickAdapter(data) {
    if (data.hook_event_name) return getAdapter('codex') || getDefaultAdapter();
    return getDefaultAdapter();
}

function main() {
    try {
        const chunks = [];
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', async () => {
            try {
                const input = Buffer.concat(chunks).toString('utf-8');
                if (!input.trim()) return;

                const data = JSON.parse(input);

                const toolName = data.tool_name || data.name || '(empty)';
                try {
                    const logFile = path.join(RUNTIME_PATHS.logsDir, 'trace_post.log');
                    fs.appendFileSync(logFile, `[${new Date().toISOString()}] post: tool=${toolName}\n`, 'utf-8');
                } catch (_) {}

                if (Array.isArray(data)) {
                    for (const item of data) {
                        await pickAdapter(item).post(item);
                    }
                } else {
                    await pickAdapter(data).post(data);
                }
            } catch (e) {
                try {
                    const errorLog = path.join(RUNTIME_PATHS.logsDir, 'trace_error.log');
                    fs.appendFileSync(errorLog, `[${new Date().toISOString()}] ${e.message}\n${e.stack}\n`, 'utf-8');
                } catch (_) {}
            }
        });
        process.stdin.on('error', (e) => {
            try {
                const errorLog = path.join(RUNTIME_PATHS.logsDir, 'trace_error.log');
                fs.appendFileSync(errorLog, `[${new Date().toISOString()}] stdin error: ${e.message}\n`, 'utf-8');
            } catch (_) {}
        });
    } catch (e) {}
}

main();
