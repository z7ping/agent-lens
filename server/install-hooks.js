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
const CODEX_LIFECYCLE_PATH = path.join(RUNTIME_PATHS.hooksDir, 'codex-lifecycle.js').replace(/\\/g, '/');
const WINDOWS_HOOK_RUNNER_COMMAND = 'agent-lens-hook.exe';
const WINDOWS_HOOK_RUNNER_PATH = path.join(
    RUNTIME_PATHS.binDir || RUNTIME_PATHS.hooksDir,
    RUNTIME_PATHS.binDir ? WINDOWS_HOOK_RUNNER_COMMAND : 'windows-hook-runner.exe',
).replace(/\\/g, '/');
const CLAUDE_SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');
const CODEX_HOOKS_FILE = path.join(HOME, '.codex', 'hooks.json');
const CURSOR_HOOKS_FILE = path.join(HOME, '.cursor', 'hooks.json');

const MARKER = 'agent-lens';
const CODEX_LIFECYCLE_EVENTS = [
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'PermissionRequest',
    'PreCompact',
    'PostCompact',
    'SubagentStart',
    'SubagentStop',
    'Stop',
];

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

function removeAgentLensHooks(config, marker = MARKER) {
    if (!config || typeof config !== 'object' || !config.hooks || typeof config.hooks !== 'object') {
        return false;
    }

    let changed = false;
    for (const [eventName, groups] of Object.entries(config.hooks)) {
        if (!Array.isArray(groups)) continue;
        const filtered = removeOldHooks(groups, marker);
        if (filtered.length === groups.length) continue;
        changed = true;
        if (filtered.length > 0) config.hooks[eventName] = filtered;
        else delete config.hooks[eventName];
    }

    if (Object.keys(config.hooks).length === 0) delete config.hooks;
    return changed;
}

function formatNodeHookCommand(scriptPath, options = {}) {
    const platform = options.platform || process.platform;
    if (platform === 'win32') {
        const runnerPath = options.windowsRunnerPath || WINDOWS_HOOK_RUNNER_PATH;
        const runnerCommand = options.windowsRunnerCommand || WINDOWS_HOOK_RUNNER_COMMAND;
        if (!fs.existsSync(runnerPath) && !options.skipRunnerCheck) {
            throw new Error(`缺少 Windows 无窗口 Hook 启动器: ${runnerPath}`);
        }
        return `${runnerCommand} ${JSON.stringify(scriptPath)}`;
    }
    return `node ${JSON.stringify(scriptPath)}`;
}

function makeHookEntry(command, timeout = 5) {
    return {
        hooks: [{ command, type: 'command', timeout, statusMessage: '', async: false }]
    };
}

// ─── 1. Claude Code ──────────────────────────────────────

function installClaudeCode(options = {}) {
    const settings = readJson(CLAUDE_SETTINGS_FILE);
    if (!settings.hooks) settings.hooks = {};

    // 清理已有 AgentLens hooks，避免重复安装
    settings.hooks.PreToolUse = removeOldHooks(settings.hooks.PreToolUse, MARKER);
    settings.hooks.PostToolUse = removeOldHooks(settings.hooks.PostToolUse, MARKER);

    settings.hooks.PreToolUse.push(makeHookEntry(formatNodeHookCommand(PRELOG_PATH, options), 5));
    settings.hooks.PostToolUse.push(makeHookEntry(formatNodeHookCommand(LOG_PATH, options), 10));

    writeJson(CLAUDE_SETTINGS_FILE, settings);
    console.log('   [OK] Claude Code settings.json 已更新');
}

// ─── 2. Codex ────────────────────────────────────────────

function configureCodexHooks(hooks, options = {}) {
    if (!hooks.hooks) hooks.hooks = {};

    const prelogPath = options.prelogPath || PRELOG_PATH;
    const logPath = options.logPath || LOG_PATH;
    const lifecyclePath = options.lifecyclePath || CODEX_LIFECYCLE_PATH;

    // 清理已有 AgentLens hooks，避免重复安装
    for (const eventName of ['PreToolUse', 'PostToolUse', ...CODEX_LIFECYCLE_EVENTS]) {
        hooks.hooks[eventName] = removeOldHooks(hooks.hooks[eventName], MARKER);
    }

    hooks.hooks.PreToolUse.push(makeHookEntry(formatNodeHookCommand(prelogPath, options), 5));
    hooks.hooks.PostToolUse.push(makeHookEntry(formatNodeHookCommand(logPath, options), 10));
    for (const eventName of CODEX_LIFECYCLE_EVENTS) {
        const timeout = eventName === 'SessionEnd' ? 3 : 5;
        hooks.hooks[eventName].push(makeHookEntry(formatNodeHookCommand(lifecyclePath, options), timeout));
    }
    return hooks;
}

function installCodex(options = {}) {
    const hooksFile = options.hooksFile || CODEX_HOOKS_FILE;
    const hooks = configureCodexHooks(readJson(hooksFile), options);

    writeJson(hooksFile, hooks);
    console.log('   [OK] Codex hooks.json 已更新');
}

// ─── 3. Cursor ───────────────────────────────────────────

function installCursor(options = {}) {
    const hooks = readJson(CURSOR_HOOKS_FILE);
    if (!hooks.hooks) hooks.hooks = {};

    // 清理已有 AgentLens hooks，避免重复安装
    hooks.hooks.PreToolUse = removeOldHooks(hooks.hooks.PreToolUse, MARKER);
    hooks.hooks.PostToolUse = removeOldHooks(hooks.hooks.PostToolUse, MARKER);

    hooks.hooks.PreToolUse.push(makeHookEntry(formatNodeHookCommand(PRELOG_PATH, options), 5));
    hooks.hooks.PostToolUse.push(makeHookEntry(formatNodeHookCommand(LOG_PATH, options), 10));

    writeJson(CURSOR_HOOKS_FILE, hooks);
    console.log('   [OK] Cursor hooks.json 已更新');
}

// ─── 4. 更新 Codex 信任 hash ─────────────────────────────

// Codex 事件名 → hook_event_key_label（snake_case）
const CODEX_EVENT_LABELS = {
    SessionStart: 'session_start',
    SessionEnd: 'session_end',
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

function updateCodexTrustHash(options = {}) {
    const configPath = options.configPath || path.join(HOME, '.codex', 'config.toml');
    const hooksPath = options.hooksPath || CODEX_HOOKS_FILE;
    if (!fs.existsSync(hooksPath)) return;

    const hooks = readJson(hooksPath);

    // 读取 config.toml
    let config = '';
    try { config = fs.readFileSync(configPath, 'utf-8'); } catch (_) { return; }

    // 生成 hooks.state 条目（每个 hook 独立哈希）
    const entries = [];
    for (const [eventName, groups] of Object.entries(hooks.hooks || {})) {
        if (!Array.isArray(groups)) continue;
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
    if (!options.quiet) console.log(`   [OK] Codex 信任 hash 已更新 (${entries.length / 3} 个 hook)`);
}

function uninstallHooksFromFile(filePath, label) {
    if (!fs.existsSync(filePath)) {
        console.log(`   [SKIP] ${label} 配置不存在`);
        return false;
    }

    const config = readJson(filePath);
    if (!removeAgentLensHooks(config)) {
        console.log(`   [SKIP] ${label} 未发现 AgentLens hooks`);
        return false;
    }

    writeJson(filePath, config);
    console.log(`   [OK] ${label} AgentLens hooks 已移除`);
    return true;
}

function uninstallAllToolHooks() {
    console.log('   从所有支持的工具移除 hooks...');
    uninstallHooksFromFile(CLAUDE_SETTINGS_FILE, 'Claude Code');
    const codexChanged = uninstallHooksFromFile(CODEX_HOOKS_FILE, 'Codex');
    uninstallHooksFromFile(CURSOR_HOOKS_FILE, 'Cursor');
    if (codexChanged) updateCodexTrustHash();
    console.log('   [OK] Hooks 清理完成');
}

// ─── 5. 同步 adapters + agent-lens-db 到当前 app 目录 ────────────

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

function main(argv = process.argv.slice(2)) {
    if (argv.includes('--uninstall')) {
        uninstallAllToolHooks();
        return;
    }

    console.log('   安装 hooks 到所有支持的工具...');
    syncModules();
    installClaudeCode();
    installCodex();
    installCursor();
    updateCodexTrustHash();
    console.log('   [OK] 全部完成');
}

if (require.main === module) main();

module.exports = {
    CODEX_LIFECYCLE_EVENTS,
    configureCodexHooks,
    formatNodeHookCommand,
    removeAgentLensHooks,
    removeOldHooks,
    uninstallHooksFromFile,
    updateCodexTrustHash,
};
