#!/usr/bin/env node
/**
 * PreToolUse hook: 记录工具调用开始时间和调用栈
 * 与 log.js (PostToolUse) 配合计算耗时和父子调用关系
 *
 * 委托给适配器处理具体逻辑，本文件负责：
 * 1. 自动拉起 HTTP 服务
 * 2. 读取 stdin
 * 3. 根据数据格式分发给对应适配器的 pre() 方法
 */

const path = require('path');
const { getDefaultAdapter, getAdapter } = require('../adapters');
const { ensureRuntimeDirs, getRuntimePaths } = require('../runtime-paths');

const BASE_DIR = path.join(__dirname, '..');
const RUNTIME_PATHS = getRuntimePaths({ baseDir: BASE_DIR });
ensureRuntimeDirs(RUNTIME_PATHS);

function logError(e) {
    try {
        const fs = require('fs');
        const logFile = path.join(RUNTIME_PATHS.logsDir, 'trace_error.log');
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] PreToolUse prelog.js: ${e.message || e}\n`, 'utf-8');
    } catch (_) {}
}

// Codex 数据有 hook_event_name 字段，Claude Code 没有
function pickAdapter(data) {
    if (data.hook_event_name) return getAdapter('codex') || getDefaultAdapter();
    return getDefaultAdapter();
}

function main() {
    try {
        const guard = require('./server-guard');
        guard.ensureServerRunning(BASE_DIR);
    } catch (_) {}

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
                    const fs = require('fs');
                    const logFile = path.join(RUNTIME_PATHS.logsDir, 'trace_pre.log');
                    fs.appendFileSync(logFile, `[${new Date().toISOString()}] pre: tool=${toolName}\n`, 'utf-8');
                } catch (_) {}

                if (Array.isArray(data)) {
                    for (const item of data) {
                        await pickAdapter(item).pre(item);
                    }
                } else {
                    await pickAdapter(data).pre(data);
                }
            } catch (e) {
                logError(e);
            }
        });
        process.stdin.on('error', (e) => { logError(e); });
    } catch (e) { logError(e); }
}

main();
