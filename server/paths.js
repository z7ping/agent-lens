/**
 * paths.js - 跨平台路径解析
 * 各工具在不同 OS 下的数据目录不同，统一在此管理。
 * 支持环境变量覆盖。
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';

// 环境变量覆盖 > 平台默认值
function resolvePath(envKey, platformDefault) {
    const env = process.env[envKey];
    if (env && env.trim()) return env.trim();
    return platformDefault;
}

function firstExistingPath(paths, fallback) {
    for (const p of paths) {
        if (p && fs.existsSync(p)) return p;
    }
    return fallback;
}

function pickFirstExistingPath(paths, fallback) {
    return firstExistingPath(paths, fallback);
}

// ─── Hermes ──────────────────────────────────────────────
// Linux/macOS: ~/.hermes/state.db
// Windows:     %LOCALAPPDATA%\hermes\state.db
// Override:    HERMES_HOME
const hermesHome = IS_WIN
    ? resolvePath('HERMES_HOME', path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'hermes'))
    : resolvePath('HERMES_HOME', path.join(HOME, '.hermes'));

// ─── OpenCode ────────────────────────────────────────────
// Linux/macOS: ~/.local/share/opencode/opencode.db  (XDG)
// Windows:     %APPDATA%\opencode\opencode.db
// Override:    OPENCODE_HOME
const winOpenCodeCandidates = [
    path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'opencode'),
    path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'opencode'),
    path.join(HOME, '.local', 'share', 'opencode'),
    path.join(HOME, '.opencode'),
];
const winOpenCodeDbCandidates = winOpenCodeCandidates.map(p => path.join(p, 'opencode.db'));
const opencodeHome = resolvePath(
    'OPENCODE_HOME',
    IS_WIN ? path.dirname(firstExistingPath(winOpenCodeDbCandidates, winOpenCodeDbCandidates[0])) : path.join(HOME, '.local', 'share', 'opencode')
);

// ─── Pi ──────────────────────────────────────────────────
// Linux/macOS: ~/.pi/agent/sessions
// Windows:     prefers ~/.pi/agent/sessions, falls back to %APPDATA%\pi and %LOCALAPPDATA%\pi
// Override:    PI_HOME
const winPiCandidates = [
    path.join(HOME, '.pi'),
    path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'pi'),
    path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'pi'),
];
const piHome = resolvePath(
    'PI_HOME',
    IS_WIN ? firstExistingPath(winPiCandidates, winPiCandidates[0]) : path.join(HOME, '.pi')
);

// ─── agent-trace (self) ─────────────────────────────────
// 所有平台: ~/.agent-trace
const agentTraceHome = path.join(HOME, '.agent-trace');

// ─── Claude Code ─────────────────────────────────────────
// 所有平台: ~/.claude/projects/**/*.jsonl 保存完整会话历史
// Override: CLAUDE_CODE_HOME
const claudeCodeHome = resolvePath('CLAUDE_CODE_HOME', path.join(HOME, '.claude'));

// ─── Codex ───────────────────────────────────────────────
// 所有平台: ~/.codex/sessions/YYYY/MM/DD/*.jsonl 保存 rollout 记录
// Override: CODEX_HOME
const codexHome = resolvePath('CODEX_HOME', path.join(HOME, '.codex'));

module.exports = {
    IS_WIN,
    HOME,
    hermes: {
        home: hermesHome,
        stateDb: path.join(hermesHome, 'state.db'),
    },
    opencode: {
        home: opencodeHome,
        db: path.join(opencodeHome, 'opencode.db'),
    },
    pi: {
        home: piHome,
        sessionsDir: path.join(piHome, 'agent', 'sessions'),
    },
    claudeCode: {
        home: claudeCodeHome,
        projectsDir: path.join(claudeCodeHome, 'projects'),
        settingsFile: path.join(claudeCodeHome, 'settings.json'),
    },
    codex: {
        home: codexHome,
        sessionsDir: path.join(codexHome, 'sessions'),
        hooksFile: path.join(codexHome, 'hooks.json'),
    },
    agentTrace: {
        home: agentTraceHome,
    },
    pickFirstExistingPath,
};
