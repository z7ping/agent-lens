#!/usr/bin/env node
/**
 * sources-status.js - 各来源采集状态检测
 *
 * 判断每个工具：
 *  - historyAvailable：历史 JSONL 是否可导入（不依赖 hook）
 *  - hookInstalled   ：AgentLens 的实时 hook 是否已接入该工具
 *  - sessionFiles    ：历史会话文件数（仅统计用）
 */

const fs = require('fs');
const path = require('path');
const { claudeCode, codex, agentLens, pi } = require('./paths');
const { CODEX_LIFECYCLE_EVENT_TYPES } = require('./codex-lifecycle');
const { getRuntimePaths, isSourceLayout } = require('./runtime-paths');

const CODEX_REQUIRED_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', ...Object.keys(CODEX_LIFECYCLE_EVENT_TYPES)];

function countJsonlRecursive(dir) {
    if (!fs.existsSync(dir)) return 0;
    let count = 0;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) count += countJsonlRecursive(full);
            else if (entry.name.endsWith('.jsonl')) count++;
        }
    } catch (_) {}
    return count;
}

/** 判断 hook 配置中是否引用了 agent-lens 自己的钩子脚本 */
function hooksReferenceAgentLens(hookConfigText) {
    if (!hookConfigText) return false;
    return /agent-lens|prelog\.js|hooks[\\/]log\.js|\.agent-lens/i.test(hookConfigText);
}

function inspectCodexHookCoverage(hookConfigText) {
    let config;
    try { config = JSON.parse(hookConfigText || '{}'); } catch (_) { config = {}; }
    const configuredEvents = CODEX_REQUIRED_HOOK_EVENTS.filter(eventName => {
        const groups = config?.hooks?.[eventName];
        return Array.isArray(groups) && groups.some(group =>
            Array.isArray(group?.hooks) && group.hooks.some(hook =>
                /agent-lens|prelog\.js|hooks[\\/]log\.js|\.agent-lens/i.test(String(hook?.command || ''))
            )
        );
    });
    return {
        configured: configuredEvents.length,
        expected: CODEX_REQUIRED_HOOK_EVENTS.length,
        complete: configuredEvents.length === CODEX_REQUIRED_HOOK_EVENTS.length,
        missingEvents: CODEX_REQUIRED_HOOK_EVENTS.filter(eventName => !configuredEvents.includes(eventName)),
    };
}

function fileExists(filePath) {
    return Boolean(filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile());
}

function dirExists(dirPath) {
    return Boolean(dirPath && fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory());
}

function readPackageVersion(packagePath) {
    try {
        const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
        return String(pkg.version || '');
    } catch (_) {
        return '';
    }
}

function readJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (_) {
        return null;
    }
}

function normalizeArray(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === false) return [];
    return [value];
}

function expandHomePath(input, homeDir = require('os').homedir()) {
    const text = String(input || '').trim();
    if (!text) return '';
    if (text === '~') return homeDir;
    if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(homeDir, text.slice(2));
    return text;
}

function resolvePiConfigPath(input, baseDir, homeDir) {
    const expanded = expandHomePath(input, homeDir);
    if (!expanded) return '';
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

function piExtensionEntryText(entry) {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return '';
    return String(entry.path || entry.source || entry.module || entry.name || entry.package || '');
}

function inspectPiRuntimeExtensionConfig(settings, agentDir, extensionFile, options = {}) {
    const homeDir = options.homeDir;
    const extensionNamePattern = /agent-lens|pi-runtime-extension/i;
    const extensionFileResolved = path.resolve(extensionFile);
    const entries = normalizeArray(settings?.extensions);
    const matched = entries.filter(entry => {
        const raw = piExtensionEntryText(entry);
        if (!raw) return false;
        const clean = raw.startsWith('+') ? raw.slice(1) : raw;
        if (extensionNamePattern.test(clean)) return true;
        const resolved = resolvePiConfigPath(clean, agentDir, homeDir);
        return resolved && path.resolve(resolved) === extensionFileResolved;
    });
    return {
        configured: matched.length > 0,
        configured_count: matched.length,
    };
}

function diagnosePiRuntimeExtension(options = {}) {
    const runtime = options.runtimePaths || getRuntimePaths({ baseDir: options.baseDir });
    const agentDir = options.agentDir || pi.agentDir;
    const settingsPath = options.settingsPath || path.join(agentDir, 'settings.json');
    const extensionFile = options.extensionFile || path.join(runtime.hooksDir, 'pi-runtime-extension.js');
    const settings = readJsonFile(settingsPath);
    const extensionExists = fileExists(extensionFile);
    const settingsExists = fileExists(settingsPath);
    const config = inspectPiRuntimeExtensionConfig(settings, agentDir, extensionFile, options);
    const checks = [
        installCheck('extension_file', 'Pi 运行时扩展文件', extensionFile, extensionExists),
        installCheck('settings_file', 'Pi settings.json', settingsPath, settingsExists, 'optional'),
        installCheck('configured_extension', 'Pi 扩展配置引用', settingsPath, config.configured, 'optional'),
    ];

    let status = 'missing';
    let label = 'Pi 运行时扩展未随 AgentLens 安装';
    if (extensionExists && config.configured) {
        status = 'available';
        label = 'Pi 运行时扩展已打包并已配置';
    } else if (extensionExists) {
        status = 'packaged';
        label = settingsExists ? 'Pi 运行时扩展已打包，尚未配置' : 'Pi 运行时扩展已打包，未找到 Pi settings.json';
    }

    return {
        status,
        label,
        extensionFile,
        agentDir,
        settingsPath,
        configured: config.configured,
        configured_count: config.configured_count,
        checks,
    };
}

function installCheck(id, label, target, ok, severity = 'required', details = '') {
    return {
        id,
        label,
        target: target || '',
        ok: Boolean(ok),
        severity,
        details,
    };
}

function summarizeChecks(checks = []) {
    const requiredMissing = checks.filter(item => item.severity === 'required' && !item.ok);
    const optionalMissing = checks.filter(item => item.severity !== 'required' && !item.ok);
    if (requiredMissing.length) {
        return {
            status: 'broken',
            label: `安装异常 · 缺少 ${requiredMissing.length} 项关键文件`,
            missing_required: requiredMissing.map(item => item.id),
            missing_optional: optionalMissing.map(item => item.id),
        };
    }
    if (optionalMissing.length) {
        return {
            status: 'warn',
            label: `安装可用 · ${optionalMissing.length} 项建议检查未通过`,
            missing_required: [],
            missing_optional: optionalMissing.map(item => item.id),
        };
    }
    return {
        status: 'ok',
        label: '安装可用',
        missing_required: [],
        missing_optional: [],
    };
}

function diagnoseAgentLensInstall(options = {}) {
    const baseDir = options.baseDir || __dirname;
    const platform = options.platform || process.platform;
    const runtime = options.runtimePaths || getRuntimePaths({ baseDir });
    const sourceLayout = isSourceLayout(baseDir);
    const packagePath = path.join(runtime.appDir, 'package.json');
    const windowsHookRunner = platform === 'win32'
        ? path.join(runtime.binDir || runtime.appDir, 'agent-lens-hook.exe')
        : '';
    const checks = [
        installCheck('root_dir', '运行根目录', runtime.rootDir, dirExists(runtime.rootDir)),
        installCheck('app_dir', '应用目录', runtime.appDir, dirExists(runtime.appDir)),
        installCheck('package_json', 'package.json', packagePath, fileExists(packagePath)),
        installCheck('dist_index', '前端产物', path.join(runtime.distDir, 'index.html'), fileExists(path.join(runtime.distDir, 'index.html'))),
        installCheck('pre_hook', 'PreToolUse Hook 脚本', path.join(runtime.hooksDir, 'prelog.js'), fileExists(path.join(runtime.hooksDir, 'prelog.js'))),
        installCheck('post_hook', 'PostToolUse Hook 脚本', path.join(runtime.hooksDir, 'log.js'), fileExists(path.join(runtime.hooksDir, 'log.js'))),
        installCheck('lifecycle_hook', 'Codex 生命周期 Hook 脚本', path.join(runtime.hooksDir, 'codex-lifecycle.js'), fileExists(path.join(runtime.hooksDir, 'codex-lifecycle.js')), 'optional'),
        installCheck('data_dir', '数据目录', runtime.dataDir, dirExists(runtime.dataDir), 'optional'),
        installCheck('run_dir', '运行目录', runtime.runDir, dirExists(runtime.runDir), 'optional'),
        installCheck('pid_file', '服务 PID 文件', runtime.pidFile, fileExists(runtime.pidFile), 'optional'),
        installCheck('hook_token', 'Hook 写入令牌', runtime.hookTokenFile, fileExists(runtime.hookTokenFile), 'optional'),
    ];
    if (platform === 'win32') {
        checks.push(installCheck('windows_hook_runner', 'Windows Hook Runner', windowsHookRunner, fileExists(windowsHookRunner)));
    }
    const summary = summarizeChecks(checks);
    return {
        ...summary,
        layout: sourceLayout ? 'source' : 'installed',
        version: readPackageVersion(packagePath),
        rootDir: runtime.rootDir,
        appDir: runtime.appDir,
        binDir: runtime.binDir || '',
        checks,
    };
}

function detectSourceStatus() {
    // ─── Claude Code ───
    const claudeSettingsText = fs.existsSync(claudeCode.settingsFile) ? safeRead(claudeCode.settingsFile) : '';
    const claudeHookInstalled = hooksReferenceAgentLens(claudeSettingsText);

    // ─── Codex ───
    const codexHooksText = fs.existsSync(codex.hooksFile) ? safeRead(codex.hooksFile) : '';
    const codexHookInstalled = hooksReferenceAgentLens(codexHooksText);
    const codexHookCoverage = inspectCodexHookCoverage(codexHooksText);

    const installDiagnostics = diagnoseAgentLensInstall();
    const piRuntimeExtension = diagnosePiRuntimeExtension();
    const agentLensInstalled = fs.existsSync(path.join(agentLens.appDir || agentLens.home, 'hooks')) ||
        fs.existsSync(path.join(agentLens.appDir || agentLens.home, 'install-hooks.js'));

    return {
        'claude-code': {
            historyAvailable: countJsonlRecursive(claudeCode.projectsDir) > 0,
            hookInstalled: claudeHookInstalled,
            sessionFiles: countJsonlRecursive(claudeCode.projectsDir),
            dataDir: claudeCode.projectsDir,
        },
        codex: {
            historyAvailable: countJsonlRecursive(codex.sessionsDir) > 0,
            hookInstalled: codexHookInstalled,
            hookCoverage: codexHookCoverage,
            sessionFiles: countJsonlRecursive(codex.sessionsDir),
            dataDir: codex.sessionsDir,
        },
        pi: {
            historyAvailable: countJsonlRecursive(pi.sessionsDir) > 0,
            hookInstalled: piRuntimeExtension.status === 'available',
            runtimeExtension: piRuntimeExtension,
            sessionFiles: countJsonlRecursive(pi.sessionsDir),
            dataDir: pi.sessionsDir,
        },
        agentLensInstalled,
        agentLens: installDiagnostics,
    };
}

function safeRead(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch {
        return '';
    }
}

module.exports = {
    detectSourceStatus,
    hooksReferenceAgentLens,
    inspectCodexHookCoverage,
    diagnoseAgentLensInstall,
    diagnosePiRuntimeExtension,
    inspectPiRuntimeExtensionConfig,
};
