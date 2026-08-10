#!/usr/bin/env node
/**
 * install-hooks.js - 更新所有支持工具的 hooks 配置
 * 覆盖：Claude Code (~/.claude/settings.json)、Codex (~/.codex/hooks.json)、Cursor (~/.cursor/hooks.json)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureRuntimeDirs, getRuntimePaths } = require('./runtime-paths');

const HOME = os.homedir();
const RUNTIME_PATHS = getRuntimePaths({ baseDir: __dirname });
ensureRuntimeDirs(RUNTIME_PATHS);
const TOOL_TRACKER_DIR = RUNTIME_PATHS.appDir;
const PRELOG_PATH = path.join(RUNTIME_PATHS.hooksDir, 'prelog.js').replace(/\\/g, '/');
const LOG_PATH = path.join(RUNTIME_PATHS.hooksDir, 'log.js').replace(/\\/g, '/');

const MARKER = 'agent-lens';

// ─── 工具函数 ────────────────────────────────────────────

function readJson(filePath) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_) {}
    return {};
}

function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function removeOldHooks(hookArray, marker = MARKER) {
    if (!Array.isArray(hookArray)) return [];
    return hookArray.filter(entry => {
        if (!entry || !entry.hooks) return true;
        return !entry.hooks.some(h => h.command && h.command.includes(marker));
    });
}

function makeHookEntry(command, timeout = 5) {
    return {
        hooks: [{ command, type: 'command', timeout, statusMessage: '', async: false }]
    };
}

// ─── 1. Claude Code ──────────────────────────────────────

function installClaudeCode() {
    const settingsFile = path.join(HOME, '.claude', 'settings.json');
    const settings = readJson(settingsFile);
    if (!settings.hooks) settings.hooks = {};

    // 清理已有 AgentLens hooks，避免重复安装
    settings.hooks.PreToolUse = removeOldHooks(settings.hooks.PreToolUse, MARKER);
    settings.hooks.PostToolUse = removeOldHooks(settings.hooks.PostToolUse, MARKER);

    settings.hooks.PreToolUse.push(makeHookEntry(`node ${PRELOG_PATH}`, 5));
    settings.hooks.PostToolUse.push(makeHookEntry(`node ${LOG_PATH}`, 10));

    writeJson(settingsFile, settings);
    console.log('   [OK] Claude Code settings.json 已更新');
}

// ─── 2. Codex ────────────────────────────────────────────

function installCodex() {
    const hooksFile = path.join(HOME, '.codex', 'hooks.json');
    const hooks = readJson(hooksFile);
    if (!hooks.hooks) hooks.hooks = {};

    // 清理已有 AgentLens hooks，避免重复安装
    hooks.hooks.PreToolUse = removeOldHooks(hooks.hooks.PreToolUse, MARKER);
    hooks.hooks.PostToolUse = removeOldHooks(hooks.hooks.PostToolUse, MARKER);

    hooks.hooks.PreToolUse.push(makeHookEntry(`node ${PRELOG_PATH}`, 5));
    hooks.hooks.PostToolUse.push(makeHookEntry(`node ${LOG_PATH}`, 10));

    writeJson(hooksFile, hooks);
    console.log('   [OK] Codex hooks.json 已更新');
}

// ─── 3. Cursor ───────────────────────────────────────────

function installCursor() {
    const hooksFile = path.join(HOME, '.cursor', 'hooks.json');
    const hooks = readJson(hooksFile);
    if (!hooks.hooks) hooks.hooks = {};

    // 清理已有 AgentLens hooks，避免重复安装
    hooks.hooks.PreToolUse = removeOldHooks(hooks.hooks.PreToolUse, MARKER);
    hooks.hooks.PostToolUse = removeOldHooks(hooks.hooks.PostToolUse, MARKER);

    hooks.hooks.PreToolUse.push(makeHookEntry(`node ${PRELOG_PATH}`, 5));
    hooks.hooks.PostToolUse.push(makeHookEntry(`node ${LOG_PATH}`, 10));

    writeJson(hooksFile, hooks);
    console.log('   [OK] Cursor hooks.json 已更新');
}

// ─── 4. 更新 Codex 信任 hash ─────────────────────────────

// Codex 事件名 → hook_event_key_label（snake_case）
const CODEX_EVENT_LABELS = {
    SessionStart: 'session_start',
    UserPromptSubmit: 'user_prompt_submit',
    PreToolUse: 'pre_tool_use',
    PermissionRequest: 'permission_request',
    PostToolUse: 'post_tool_use',
    PreCompact: 'pre_compact',
    PostCompact: 'post_compact',
    SubagentStart: 'subagent_start',
    SubagentStop: 'subagent_stop',
    Stop: 'stop',
};

function canonicalJson(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(canonicalJson);
    return Object.keys(obj).sort().reduce((acc, key) => {
        acc[key] = canonicalJson(obj[key]);
        return acc;
    }, {});
}

function computeHookHash(eventName, group, handler) {
    const crypto = require('crypto');
    const identity = {
        event_name: CODEX_EVENT_LABELS[eventName] || eventName.toLowerCase(),
        hooks: [handler],
    };
    if (group.matcher) identity.matcher = group.matcher;
    const canonical = canonicalJson(identity);
    const serialized = JSON.stringify(canonical);
    const hash = crypto.createHash('sha256').update(serialized, 'utf-8').digest('hex');
    return `sha256:${hash}`;
}

function updateCodexTrustHash() {
    const configPath = path.join(HOME, '.codex', 'config.toml');
    const hooksPath = path.join(HOME, '.codex', 'hooks.json');
    if (!fs.existsSync(hooksPath)) return;

    const hooks = readJson(hooksPath);

    // 读取 config.toml
    let config = '';
    try { config = fs.readFileSync(configPath, 'utf-8'); } catch (_) { return; }

    // 生成 hooks.state 条目（每个 hook 独立哈希）
    const entries = [];
    for (const [eventName, groups] of Object.entries(hooks.hooks || {})) {
        const eventKey = CODEX_EVENT_LABELS[eventName] || eventName.toLowerCase();
        groups.forEach((group, groupIdx) => {
            (group.hooks || []).forEach((hook, hookIdx) => {
                const hash = computeHookHash(eventName, group, hook);
                const stateKey = `${hooksPath.replace(/\\/g, '\\\\')}:${eventKey}:${groupIdx}:${hookIdx}`;
                entries.push(`[hooks.state."${stateKey}"]`);
                entries.push(`trusted_hash = "${hash}"`);
                entries.push('');
            });
        });
    }

    // 移除旧的 hooks.state 条目，插入新的
    const lines = config.split('\n');
    const newLines = [];
    let skip = false;
    for (const line of lines) {
        if (line.startsWith('[hooks.state')) {
            skip = true;
            continue;
        }
        if (skip && line.startsWith('[')) skip = false;
        if (!skip) newLines.push(line);
    }

    // 在合适的位置插入 hooks.state
    let insertIdx = newLines.findIndex(l => l.startsWith('[features]'));
    if (insertIdx < 0) insertIdx = newLines.length;
    newLines.splice(insertIdx, 0, '', '[hooks.state]', ...entries);

    fs.writeFileSync(configPath, newLines.join('\n'));
    console.log(`   [OK] Codex 信任 hash 已更新 (${entries.length / 3} 个 hook)`);
}

// ─── 5. 同步 adapters + agent-lens-db 到 ~/.agent-lens/ ─────────

function syncModules() {
    const srcDir = path.join(__dirname, 'adapters');
    const dstDir = path.join(TOOL_TRACKER_DIR, 'adapters');
    const srcDb = path.join(__dirname, 'agent-lens-db.js');
    const dstDb = path.join(TOOL_TRACKER_DIR, 'agent-lens-db.js');
    const srcPaths = path.join(__dirname, 'paths.js');
    const dstPaths = path.join(TOOL_TRACKER_DIR, 'paths.js');

    fs.mkdirSync(dstDir, { recursive: true });

    // 复制所有 adapter 文件
    for (const f of fs.readdirSync(srcDir)) {
        fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
    }
    // 复制 agent-lens-db.js
    if (fs.existsSync(srcDb)) {
        fs.copyFileSync(srcDb, dstDb);
    }
    // 复制 paths.js
    if (fs.existsSync(srcPaths)) {
        fs.copyFileSync(srcPaths, dstPaths);
    }
    console.log('   [OK] adapters + agent-lens-db 已同步');
}

// ─── 执行 ────────────────────────────────────────────────

console.log('   安装 hooks 到所有支持的工具...');
syncModules();
installClaudeCode();
installCodex();
installCursor();
updateCodexTrustHash();
console.log('   [OK] 全部完成');
