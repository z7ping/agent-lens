#!/usr/bin/env node
/**
 * AgentLens - 统一 CLI 入口
 *
 * 用法:
 *   agent-lens install                       安装应用、依赖和 hooks
 *   agent-lens start [port]                  前台启动服务器
 *   agent-lens start --port 8080 --open      指定端口并打开浏览器
 *   agent-lens start --daemon                后台守护进程模式
 *   agent-lens stop                          停止后台服务
 *   agent-lens status                        查看服务状态
 *   agent-lens service <subcommand>          管理系统服务
 *   agent-lens package [--output <dir>]      打包分发
 *   agent-lens uninstall                     卸载并清理所有配置和数据
 *
 * 替代: install.sh, install.bat, start.sh, start.bat, package.sh
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync, execFileSync } = require('child_process');
const net = require('net');
const http = require('http');
const {
    ensureRuntimeDirs,
    getFlatInstalledRuntimePaths,
    getLegacyInstalledRuntimePaths,
    getRuntimePaths,
} = require('./runtime-paths');
const {
    activateStagedApplication,
    cleanupFlatApplication,
    hasFlatApplication,
    migrateLegacyRuntimeData,
    removeTree,
    restoreBackupApplication,
    stageApplication,
} = require('./install-layout');
const { acquireInstallLock, removeInstallLock } = require('./install-lock');

// ─── 配置 ────────────────────────────────────────────────────────

const IS_SOURCE_LAYOUT = path.basename(__dirname) === 'server';
const PROJECT_DIR = IS_SOURCE_LAYOUT ? path.dirname(__dirname) : __dirname;
const CURRENT_RUNTIME_PATHS = getRuntimePaths({ baseDir: __dirname });
const INSTALL_RUNTIME_PATHS = getRuntimePaths({ layout: 'installed' });
const FLAT_INSTALL_RUNTIME_PATHS = getFlatInstalledRuntimePaths();
const LEGACY_INSTALL_RUNTIME_PATHS = getLegacyInstalledRuntimePaths();
const INSTALL_ROOT = INSTALL_RUNTIME_PATHS.rootDir;
const INSTALL_DIR = INSTALL_RUNTIME_PATHS.appDir;
const INSTALL_BIN_DIR = INSTALL_RUNTIME_PATHS.binDir;
const WINDOWS_HOOK_RUNNER_NAME = 'agent-lens-hook.exe';
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const { DEFAULT_PORT } = require('./config');
const INSTALL_READY_TIMEOUT_MS = 120000;
const WINDOWS_ACTIVATION_RETRY_DELAY_MS = 250;
const WINDOWS_ACTIVATION_MAX_ATTEMPTS = 40;
// ponytail: 版本号仅打包时用，按需读取，不复制 package.json
function getVersion() {
    try { return require(path.join(PROJECT_DIR, 'package.json')).version; } catch { return '0.0.0'; }
}

// ─── systemd 配置 ──────────────────────────────────────────────────
const SERVICE_NAME = 'agent-lens';
const SYSTEMD_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const SERVICE_FILE = path.join(SYSTEMD_DIR, `${SERVICE_NAME}.service`);
const NODE_BIN = process.execPath; // 当前 node 路径

// ─── 彩色输出 ────────────────────────────────────────────────────

const c = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

function log(msg, color = 'reset') {
    console.log(`${c[color]}${msg}${c.reset}`);
}

// ─── 工具函数 ────────────────────────────────────────────────────

function isWin() {
    return process.platform === 'win32';
}

function checkNodeAvailable() {
    try {
        execFileSync(process.execPath, ['--version'], { stdio: 'ignore', windowsHide: true });
        return true;
    } catch {
        return false;
    }
}

function mkdirp(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function rimraf(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ─── PID 管理 ────────────────────────────────────────────────────

function getPidFile(baseDir) {
    const resolved = path.resolve(baseDir || PROJECT_DIR);
    if (resolved === path.resolve(INSTALL_DIR)) return INSTALL_RUNTIME_PATHS.pidFile;
    if (resolved === path.resolve(PROJECT_DIR)) return CURRENT_RUNTIME_PATHS.pidFile;
    return getRuntimePaths({ baseDir: resolved }).pidFile;
}

function readPid(baseDir) {
    try {
        const pf = getPidFile(baseDir);
        if (fs.existsSync(pf)) {
            const pid = parseInt(fs.readFileSync(pf, 'utf-8').trim(), 10);
            if (!isNaN(pid) && pid > 0) return pid;
        }
    } catch (_) {}
    return null;
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function isPortListening(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(500);
        socket.on('connect', () => finish(true));
        socket.on('timeout', () => finish(false));
        socket.on('error', () => finish(false));
        socket.connect(port, '127.0.0.1');
    });
}

function startInstalledDaemon(port = DEFAULT_PORT) {
    const installedServer = path.join(INSTALL_DIR, 'server.js');
    const child = spawn(process.execPath, [installedServer, String(port), '--daemon'], {
        cwd: INSTALL_DIR,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.unref();
}

function syncInstalledHooks(warningLabel = '更新 Hooks 配置失败') {
    try {
        execFileSync(process.execPath, [path.join(INSTALL_DIR, 'install-hooks.js')], {
            stdio: 'inherit',
            windowsHide: true,
        });
        return true;
    } catch (error) {
        log(`[WARN] ${warningLabel}: ${error.message}`, 'yellow');
        return false;
    }
}

function isHttpReady(port, expectedVersion) {
    return readHttpAppInfo(port).then(info => Boolean(
        info && (!expectedVersion || info.version === expectedVersion)
    ));
}

function readHttpAppInfo(port = DEFAULT_PORT) {
    return new Promise((resolve) => {
        const req = http.get({
            hostname: '127.0.0.1',
            port,
            path: '/api/app-info',
            timeout: 1000,
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                if (body.length < 16384) body += chunk;
            });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) return resolve(false);
                try {
                    const info = JSON.parse(body || '{}');
                    resolve(info?.name === '@z7ping/agent-lens' && typeof info.version === 'string'
                        ? info
                        : null);
                } catch (_) {
                    resolve(null);
                }
            });
        });
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.on('error', () => resolve(false));
    });
}

async function waitForInstalledDaemon(port, timeoutMs = INSTALL_READY_TIMEOUT_MS, expectedVersion = null) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pid = readPid(INSTALL_DIR);
        if (pid && isProcessAlive(pid) && await isHttpReady(port, expectedVersion)) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
}

function readInstalledVersion() {
    try {
        return JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8')).version || null;
    } catch (_) {
        return null;
    }
}

async function waitForPortClosed(port, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!await isPortListening(port)) return true;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
}

// ─── 跨平台服务管理 ──────────────────────────────────────────────
//
// Linux   → systemd user service (~/.config/systemd/user/)
// macOS   → launchd agent     (~/Library/LaunchAgents/)
// Windows → 当前用户的“启动”目录（登录时启动，无需管理员权限）
//

const SERVICE_LABEL = 'com.agent-lens';
const LAUNCHD_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const LAUNCHD_PLIST = path.join(LAUNCHD_DIR, `${SERVICE_LABEL}.plist`);
const WINDOWS_STARTUP_DIR = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'
);
const WINDOWS_STARTUP_FILE = path.join(WINDOWS_STARTUP_DIR, 'AgentLens.vbs');

function isMac() { return process.platform === 'darwin'; }

/**
 * 返回当前平台可用的服务后端: 'windows-startup' | 'systemd' | 'launchd' | null
 */
function getServiceBackend() {
    if (isWin()) return 'windows-startup';
    if (isMac()) {
        try {
            execSync('launchctl version', { stdio: 'ignore' });
            return 'launchd';
        } catch {
            return null;
        }
    }
    // Linux
    try {
        execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
        return 'systemd';
    } catch {
        return null;
    }
}

// ─── systemd 实现（Linux）────────────────────────────────────────

// Windows 当前用户启动目录实现
function windowsStartupInstall() {
    const serverJs = path.join(INSTALL_DIR, 'server.js');
    if (!fs.existsSync(serverJs)) {
        throw new Error(`未找到已安装的服务程序: ${serverJs}`);
    }
    const quoteVbs = value => `"${String(value).replace(/"/g, '""')}"`;
    const command = `"${NODE_BIN}" "${serverJs}" ${DEFAULT_PORT} --daemon`;
    const content = [
        'Set objShell = CreateObject("WScript.Shell")',
        `objShell.CurrentDirectory = ${quoteVbs(INSTALL_DIR)}`,
        `objShell.Run ${quoteVbs(command)}, 0, False`,
        '',
    ].join('\r\n');
    mkdirp(WINDOWS_STARTUP_DIR);
    fs.writeFileSync(WINDOWS_STARTUP_FILE, content, 'utf-8');
    log('[OK] Windows 开机自启已注册，将在当前用户登录后自动启动', 'green');
}

function windowsStartupStart() {
    const pid = readPid(INSTALL_DIR);
    if (pid && isProcessAlive(pid)) {
        log(`服务已在运行 (PID: ${pid})`, 'yellow');
        return;
    }
    startInstalledDaemon(DEFAULT_PORT);
    log('[OK] 服务已在后台启动', 'green');
}

function windowsStartupStop() {
    cmdStop(INSTALL_DIR);
}

function windowsStartupEnable() {
    windowsStartupInstall();
    log('[OK] 已启用登录后自启', 'green');
}

function windowsStartupDisable() {
    if (fs.existsSync(WINDOWS_STARTUP_FILE)) fs.unlinkSync(WINDOWS_STARTUP_FILE);
    log('[OK] 已关闭登录后自启', 'green');
}

async function windowsStartupStatus() {
    const enabled = fs.existsSync(WINDOWS_STARTUP_FILE);
    log(`开机自启: ${enabled ? '✅ 已启用（用户登录时）' : '❌ 未启用'}`, enabled ? 'green' : 'yellow');
    await cmdStatus(INSTALL_DIR);
}

function windowsStartupUninstall() {
    cmdStop(INSTALL_DIR);
    if (fs.existsSync(WINDOWS_STARTUP_FILE)) {
        fs.unlinkSync(WINDOWS_STARTUP_FILE);
        log('[OK] Windows 开机自启已移除', 'green');
    }
}

// systemd 实现（Linux）
function systemdServiceFile() {
    const serverJs = path.join(INSTALL_DIR, 'server.js');
    return `[Unit]
Description=AgentLens - AI Agent Observability
After=network.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${serverJs} ${DEFAULT_PORT}
WorkingDirectory=${INSTALL_DIR}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
}

function systemdInstall() {
    mkdirp(SYSTEMD_DIR);
    fs.writeFileSync(SERVICE_FILE, systemdServiceFile(), 'utf-8');
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: 'ignore' });
    log('[OK] systemd 服务已注册并启用开机自启', 'green');
    // 检查 linger
    try {
        const user = os.userInfo().username;
        const lingerPath = `/var/lib/systemd/linger/${user}`;
        if (!fs.existsSync(lingerPath)) {
            log('[INFO] 建议运行: sudo loginctl enable-linger ' + user, 'yellow');
            log('  这样服务可在未登录时保持运行', 'dim');
        }
    } catch (_) {}
}

function systemdStart() {
    execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: 'ignore' });
    log('[OK] 服务已启动', 'green');
}

function systemdStop() {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'ignore' });
    log('[OK] 服务已停止', 'green');
}

function systemdEnable() {
    execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: 'ignore' });
    log('[OK] 已启用开机自启', 'green');
}

function systemdDisable() {
    execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: 'ignore' });
    log('[OK] 已关闭开机自启', 'green');
}

function systemdStatus() {
    try {
        const out = execSync(`systemctl --user is-active ${SERVICE_NAME} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        if (out === 'active') {
            log('✅ 服务运行中（systemd）', 'green');
        } else {
            log(`⚠️  服务状态: ${out}`, 'yellow');
        }
    } catch {
        log('❌ 服务未注册或未运行', 'yellow');
    }
    try {
        const enabled = execSync(`systemctl --user is-enabled ${SERVICE_NAME} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        log(`开机自启: ${enabled === 'enabled' ? '✅ 已启用' : '❌ 未启用'}`, enabled === 'enabled' ? 'green' : 'yellow');
    } catch {
        log('开机自启: ❌ 未启用', 'yellow');
    }
}

function systemdUninstall() {
    try {
        execSync(`systemctl --user stop ${SERVICE_NAME} 2>/dev/null`, { stdio: 'ignore' });
        execSync(`systemctl --user disable ${SERVICE_NAME} 2>/dev/null`, { stdio: 'ignore' });
    } catch (_) {}
    if (fs.existsSync(SERVICE_FILE)) {
        fs.unlinkSync(SERVICE_FILE);
        execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
        log('[OK] systemd 服务已移除', 'green');
    }
}

// ─── launchd 实现（macOS）────────────────────────────────────────

function launchdPlistContent() {
    const serverJs = path.join(INSTALL_DIR, 'server.js');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${serverJs}</string>
        <string>${String(DEFAULT_PORT)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${path.join(INSTALL_RUNTIME_PATHS.logsDir, 'launchd-stdout.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(INSTALL_RUNTIME_PATHS.logsDir, 'launchd-stderr.log')}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
</dict>
</plist>
`;
}

function launchdInstall() {
    mkdirp(LAUNCHD_DIR);
    fs.writeFileSync(LAUNCHD_PLIST, launchdPlistContent(), 'utf-8');
    execSync(`launchctl load ${LAUNCHD_PLIST}`, { stdio: 'ignore' });
    log('[OK] launchd 服务已注册并启用开机自启', 'green');
}

function launchdStart() {
    execSync(`launchctl start ${SERVICE_LABEL}`, { stdio: 'ignore' });
    log('[OK] 服务已启动', 'green');
}

function launchdStop() {
    execSync(`launchctl stop ${SERVICE_LABEL}`, { stdio: 'ignore' });
    log('[OK] 服务已停止', 'green');
}

function launchdEnable() {
    // launchd 的 RunAtLoad=true 已实现开机自启，重新 load 即可
    try { execSync(`launchctl unload ${LAUNCHD_PLIST}`, { stdio: 'ignore' }); } catch (_) {}
    execSync(`launchctl load ${LAUNCHD_PLIST}`, { stdio: 'ignore' });
    log('[OK] 已启用开机自启', 'green');
}

function launchdDisable() {
    execSync(`launchctl unload ${LAUNCHD_PLIST}`, { stdio: 'ignore' });
    log('[OK] 已关闭开机自启', 'green');
}

function launchdStatus() {
    try {
        const out = execSync(`launchctl list | grep ${SERVICE_LABEL}`, { encoding: 'utf-8' }).trim();
        if (out) {
            const parts = out.split(/\s+/);
            const pid = parts[0];
            const exitCode = parts[1];
            if (pid !== '-') {
                log(`✅ 服务运行中（launchd） PID: ${pid}`, 'green');
            } else {
                log(`⚠️  服务已注册但未运行（退出码: ${exitCode}）`, 'yellow');
            }
        } else {
            log('❌ 服务未注册', 'yellow');
        }
    } catch {
        log('❌ 服务未注册', 'yellow');
    }
    if (fs.existsSync(LAUNCHD_PLIST)) {
        log('开机自启: ✅ 已启用（RunAtLoad）', 'green');
    } else {
        log('开机自启: ❌ 未启用', 'yellow');
    }
}

function launchdUninstall() {
    try { execSync(`launchctl unload ${LAUNCHD_PLIST} 2>/dev/null`, { stdio: 'ignore' }); } catch (_) {}
    if (fs.existsSync(LAUNCHD_PLIST)) {
        fs.unlinkSync(LAUNCHD_PLIST);
        log('[OK] launchd 服务已移除', 'green');
    }
}

// ─── 统一 service 命令 ──────────────────────────────────────────

function platformAction(action, backend = getServiceBackend()) {
    if (!backend) {
        log('[WARN] 当前平台不支持自动服务管理', 'yellow');
        log('  手动启动: agent-lens start --daemon', 'dim');
        return false;
    }

    const map = {
        'windows-startup': { install: windowsStartupInstall, start: windowsStartupStart, stop: windowsStartupStop, enable: windowsStartupEnable, disable: windowsStartupDisable, status: windowsStartupStatus, uninstall: windowsStartupUninstall },
        systemd: { install: systemdInstall, start: systemdStart, stop: systemdStop, enable: systemdEnable, disable: systemdDisable, status: systemdStatus, uninstall: systemdUninstall },
        launchd: { install: launchdInstall, start: launchdStart, stop: launchdStop, enable: launchdEnable, disable: launchdDisable, status: launchdStatus, uninstall: launchdUninstall },
    };

    const fn = map[backend]?.[action];
    if (!fn) {
        log(`[ERROR] 不支持的操作: ${action}`, 'red');
        return false;
    }
    return fn();
}

function getServiceBackendLabel(backend) {
    return {
        'windows-startup': 'Windows 当前用户启动项',
        systemd: 'systemd user service',
        launchd: 'launchd agent',
    }[backend] || '当前平台不支持自动管理';
}

function displayVersion(version, fallback) {
    return version ? `v${version}` : fallback;
}

async function printServiceDetails(backend) {
    const commandVersion = getVersion();
    const installedVersion = readInstalledVersion();
    const runningInfo = await readHttpAppInfo(DEFAULT_PORT);
    const commandMismatch = installedVersion && commandVersion !== installedVersion;
    const runtimeMismatch = installedVersion && runningInfo && runningInfo.version !== installedVersion;

    console.log('');
    log('版本与环境:', 'cyan');
    log(`  当前命令: ${displayVersion(commandVersion, '未知')}${commandMismatch ? '（与已安装应用不同）' : ''}`, commandMismatch ? 'yellow' : 'reset');
    log(`  已安装应用: ${displayVersion(installedVersion, '未检测到')}`, installedVersion ? 'reset' : 'yellow');
    log(`  运行中服务: ${displayVersion(runningInfo?.version, '未检测到')}${runtimeMismatch ? '（与已安装应用不同）' : ''}`, runtimeMismatch ? 'yellow' : 'reset');
    log(`  Node.js: ${process.version}`);
    log(`  管理方式: ${getServiceBackendLabel(backend)}`);
    log(`  默认地址: http://127.0.0.1:${DEFAULT_PORT}/`);
    log(`  安装目录: ${INSTALL_DIR}`, 'dim');
}

async function cmdService(subcmd) {
    switch (subcmd) {
        case 'install':   return platformAction('install');
        case 'uninstall': return platformAction('uninstall');
        case 'start':     return platformAction('start');
        case 'stop':      return platformAction('stop');
        case 'enable':    return platformAction('enable');
        case 'disable':   return platformAction('disable');
        case 'status': {
            const backend = getServiceBackend();
            log('🧠 AgentLens 服务状态', 'bright');
            log('═'.repeat(45), 'dim');
            console.log('');
            await Promise.resolve(platformAction('status', backend));
            await printServiceDetails(backend);
            return undefined;
        }
        default:
            log('用法: agent-lens service <install|uninstall|start|stop|enable|disable|status>', 'cyan');
            return undefined;
    }
}

// ─── install 命令 ────────────────────────────────────────────────

async function cmdInstall() {
    log('🧠 AgentLens - 安装', 'bright');
    log('═'.repeat(45), 'dim');
    console.log('');

    if (!checkNodeAvailable()) {
        log('[ERROR] 未找到 Node.js', 'red');
        log('请安装 Node.js: https://nodejs.org/', 'yellow');
        process.exitCode = 1;
        return;
    }
    log('[OK] Node.js 可用', 'green');

    const updateRoot = path.join(INSTALL_ROOT, '.update');
    const stagedAppDir = path.join(updateRoot, 'app');
    const hadFlatLayout = hasFlatApplication(INSTALL_ROOT);
    let backupDir = null;
    let serviceReady = false;
    let running = false;
    let rolledBack = false;
    let rollbackRunning = false;
    let installLockHeld = false;

    try {
        console.log('');
        log(`准备安装目录: ${INSTALL_ROOT}`, 'cyan');
        ensureRuntimeDirs(INSTALL_RUNTIME_PATHS);
        ensureFrontendBuild(PROJECT_DIR);

        removeTree(updateRoot);
        stageApplication(PROJECT_DIR, stagedAppDir);
        log(`[OK] 程序已暂存到 ${stagedAppDir}`, 'green');

        console.log('');
        log('安装生产运行依赖（省略开发依赖）...', 'cyan');
        const runtimeDependency = installRuntimeDependencies(stagedAppDir);
        log(`[OK] 运行依赖安装完成（SQLite: ${runtimeDependency.backend}）`, 'green');

        console.log('');
        log('停止旧版服务并迁移运行数据...', 'cyan');
        acquireInstallLock(INSTALL_RUNTIME_PATHS.installLockFile);
        installLockHeld = true;
        await stopProcessesForUpgrade();

        if (fs.existsSync(LEGACY_INSTALL_RUNTIME_PATHS.rootDir) &&
            path.resolve(LEGACY_INSTALL_RUNTIME_PATHS.rootDir) !== path.resolve(INSTALL_ROOT)) {
            const migration = migrateLegacyRuntimeData(LEGACY_INSTALL_RUNTIME_PATHS, INSTALL_RUNTIME_PATHS);
            if (migration.copied.length > 0) {
                log(`[OK] 已迁移 ${migration.copied.length} 个旧版运行数据文件`, 'green');
            }
            if (migration.conflicts.length > 0) {
                log(`[WARN] ${migration.conflicts.length} 个旧版文件与现有数据冲突，已保留原目录且未覆盖`, 'yellow');
                log(`  旧目录: ${LEGACY_INSTALL_RUNTIME_PATHS.rootDir}`, 'dim');
            }
        }

        const projectsJson = INSTALL_RUNTIME_PATHS.projectsFile;
        if (!fs.existsSync(projectsJson)) fs.writeFileSync(projectsJson, '{}', 'utf8');

        backupDir = await activateStagedApplicationForUpgrade(stagedAppDir);
        removeTree(updateRoot);
        log(`[OK] 程序已安装到 ${INSTALL_DIR}`, 'green');

        try {
            createCommandEntry();
        } catch (error) {
            if (isWin()) throw error;
            log(`[WARN] 创建命令入口失败: ${error.message}`, 'yellow');
        }

        console.log('');
        log(`更新 Hooks 配置: ${SETTINGS_FILE}`, 'cyan');
        syncInstalledHooks();
        if (isWin()) {
            log('[INFO] 请重启正在运行的 AI 编码工具，使新的无窗口 Hook 命令生效', 'yellow');
        }

        console.log('');
        log('配置系统服务...', 'cyan');
        serviceReady = platformAction('install');

        if (serviceReady !== false) {
            platformAction('start');
            running = await waitForInstalledDaemon(DEFAULT_PORT, INSTALL_READY_TIMEOUT_MS, readInstalledVersion());
        } else {
            log('回退到 daemon 模式...', 'yellow');
            try {
                startInstalledDaemon(DEFAULT_PORT);
                running = await waitForInstalledDaemon(DEFAULT_PORT, INSTALL_READY_TIMEOUT_MS, readInstalledVersion());
            } catch (_) {
                running = false;
            }
        }

        if (running) {
            log(`[OK] 服务已启动 → http://localhost:${DEFAULT_PORT}/`, 'green');
            if (hadFlatLayout) {
                try {
                    const removed = cleanupFlatApplication(INSTALL_ROOT);
                    log(`[OK] 已清理平铺布局中的 ${removed.length} 个旧程序条目`, 'green');
                } catch (error) {
                    log(`[WARN] 平铺旧程序清理未完成: ${error.message}`, 'yellow');
                }
            }
            if (backupDir) {
                try { removeTree(backupDir); }
                catch (error) { log(`[WARN] 上一版程序备份清理失败: ${error.message}`, 'yellow'); }
            }
            const rollbackRoot = path.join(INSTALL_ROOT, '.rollback');
            try {
                removeTree(rollbackRoot);
            } catch (error) {
                log(`[WARN] 历史回滚目录清理失败: ${error.message}`, 'yellow');
            }
        } else {
            log('[ERROR] 新服务未能通过 PID 与 HTTP 就绪检查', 'red');
            if (backupDir) {
                const rollback = await rollbackInstalledApplication(backupDir);
                rolledBack = rollback.restored;
                rollbackRunning = rollback.running;
                if (rolledBack) backupDir = null;
            }
            if (backupDir) log(`  上一版程序保留在: ${backupDir}`, 'dim');
            process.exitCode = 1;
        }
    } catch (error) {
        removeTree(updateRoot);
        log(`[ERROR] 安装失败: ${error.message}`, 'red');
        if (backupDir) {
            const rollback = await rollbackInstalledApplication(backupDir);
            if (rollback.restored) backupDir = null;
        }
        if (backupDir) log(`上一版程序保留在: ${backupDir}`, 'yellow');
        process.exitCode = 1;
        return;
    } finally {
        if (installLockHeld) {
            try { removeInstallLock(INSTALL_RUNTIME_PATHS.installLockFile); } catch (_) {}
        }
    }

    console.log('');
    log('═'.repeat(45), 'dim');
    if (running) log('安装完成！', 'bright');
    else if (rolledBack) log(`新版本安装失败，已恢复上一版${rollbackRunning ? '并重新启动服务' : ''}`, 'yellow');
    else log('程序文件已安装，但服务启动失败', 'yellow');
    console.log('');
    log('使用方式:', 'yellow');
    if (serviceReady !== false) {
        log('  后台服务已注册，开机自动启动', 'dim');
    } else {
        log('  服务会在首次使用 Claude Code 工具时自动拉起', 'dim');
    }
    log(`  浏览器打开: http://localhost:${DEFAULT_PORT}/`, 'dim');
    log('  管理命令:', 'dim');
    log('    agent-lens service start     启动服务', 'dim');
    log('    agent-lens service stop      停止服务', 'dim');
    log('    agent-lens service disable   关闭开机自启', 'dim');
    log('    agent-lens service status    查看状态', 'dim');
    console.log('');
    log(`文档: ${INSTALL_DIR}/README.md`, 'dim');
    log(`运行数据: ${INSTALL_ROOT}`, 'dim');
    log('═'.repeat(45), 'dim');
}

// ─── start 命令 ──────────────────────────────────────────────────

function cmdStart(argv) {
    const isDaemon = argv.includes('--daemon') || argv.includes('-d');
    const shouldOpen = argv.includes('--open');

    // 解析端口: 支持 --port 56789 或直接 56789
    let port = DEFAULT_PORT;
    const portFlagIdx = argv.indexOf('--port');
    if (portFlagIdx >= 0 && argv[portFlagIdx + 1]) {
        port = parseInt(argv[portFlagIdx + 1], 10) || DEFAULT_PORT;
    } else {
        const portIdx = argv.findIndex(a => !a.startsWith('-') && !isNaN(parseInt(a, 10)));
        if (portIdx >= 0) port = parseInt(argv[portIdx], 10) || DEFAULT_PORT;
    }

    // 确保前端已构建
    const distPath = path.join(PROJECT_DIR, 'dist');
    if (!fs.existsSync(distPath)) {
        if (isDaemon) {
            log('dist/ 不存在，正在静默构建前端...', 'yellow');
            try {
                execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'ignore', windowsHide: true });
            } catch (_) {}
        } else {
            console.log('');
            log('📦 正在构建前端，请稍候...', 'bright');
            log('  （首次启动需要，后续启动直接使用缓存）', 'dim');
            console.log('');
            const startTime = Date.now();
            try {
                execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'inherit', windowsHide: true });
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log('');
                log(`✅ 前端构建完成（${elapsed}s）`, 'green');
                console.log('');
            } catch (e) {
                console.log('');
                log('⚠️ 前端构建失败，可稍后手动运行: npm run build', 'yellow');
                console.log('');
            }
        }
        if (fs.existsSync(distPath)) {
            log(`  构建产物: ${distPath}`, 'dim');
        }
    }

    const serverArgs = [String(port)];
    if (isDaemon) serverArgs.push('--daemon');
    if (shouldOpen) serverArgs.push('--open');

    // server.js 路径同样兼容两种布局
    const serverJs = path.join(PROJECT_DIR, 'server', 'server.js');
    const serverJsPath = fs.existsSync(serverJs) ? serverJs : path.join(PROJECT_DIR, 'server.js');
    if (isDaemon) {
        // 守护进程模式
        if (isWin()) {
            const child = spawn(process.execPath, [serverJsPath, ...serverArgs], {
                cwd: PROJECT_DIR,
                detached: true,
                stdio: ['ignore', 'ignore', 'ignore'],
                windowsHide: true,
            });
            child.unref();
        } else {
            // Unix: detached + unref
            const child = spawn('node', [serverJsPath, ...serverArgs], {
                cwd: PROJECT_DIR,
                detached: true,
                stdio: ['ignore', 'ignore', 'ignore'],
            });
            child.unref();
        }
        // 无输出，静默退出
    } else {
        // 前台模式
        console.log('');
        log('🧠 AgentLens - HTTP 服务器', 'bright');
        log('═'.repeat(40), 'dim');
        console.log('');
        log(`✅ 端口: ${port}`, 'green');
        log(`📂 目录: ${PROJECT_DIR}`, 'cyan');
        log(`🌐 地址: http://localhost:${port}/`, 'cyan');
        console.log('');
        log('💡 按 Ctrl+C 停止', 'dim');
        log('══════════════════════════════════════════', 'dim');
        console.log('');

        const child = spawn('node', [serverJsPath, ...serverArgs], {
            cwd: PROJECT_DIR,
            stdio: 'inherit',
        });

        child.on('exit', (code) => {
            process.exit(code || 0);
        });

        process.on('SIGINT', () => {
            child.kill('SIGINT');
        });
        process.on('SIGTERM', () => {
            child.kill('SIGTERM');
        });
    }
}

// ─── stop 命令 ───────────────────────────────────────────────────

function cmdStop(baseDir) {
    baseDir = baseDir || INSTALL_DIR;
    const pid = readPid(baseDir);
    if (!pid) {
        log('未找到运行中的服务（无 PID 文件）');
        return;
    }
    if (!isProcessAlive(pid)) {
        log(`进程 ${pid} 已不存在，清理 PID 文件`);
        try { fs.unlinkSync(getPidFile(baseDir)); } catch (_) {}
        return;
    }
    try {
        process.kill(pid, 'SIGTERM');
        try { fs.unlinkSync(getPidFile(baseDir)); } catch (_) {}
        log(`✅ 已停止服务 (PID: ${pid})`, 'green');
    } catch (e) {
        log(`停止失败: ${e.message}`, 'red');
        process.exit(1);
    }
}

// ─── uninstall 命令 ──────────────────────────────────────────────

async function cmdUninstall() {
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const answer = await new Promise(resolve => {
        rl.question(`${c.yellow}确定要卸载吗？这会删除所有配置和数据 (y/N): ${c.reset}`, resolve);
    });
    rl.close();

    if (answer.trim() !== 'y' && answer.trim() !== 'Y') {
        log('已取消卸载', 'yellow');
        return;
    }

    log('🧠 AgentLens - 卸载', 'bright');
    log('═'.repeat(45), 'dim');
    console.log('');

    // 1. 停止运行中的服务（跨平台）
    log('停止运行中的服务...', 'cyan');
    try {
        platformAction('uninstall');
    } catch (_) {
        log('[SKIP] 系统服务未注册', 'dim');
    }
    try {
        cmdStop(INSTALL_DIR);
    } catch (_) {
        log('[SKIP] 无需停止（未运行）', 'dim');
    }

    // 2. 清理命令入口和 PATH
    log('清理命令入口...', 'cyan');
    if (isWin()) {
        try {
            setWindowsUserPath(INSTALL_BIN_DIR, true);
            log('[OK] 已从用户 PATH 移除 AgentLens 安装路径', 'green');
        } catch (error) {
            log(`[WARN] 清理用户 PATH 失败: ${error.message}`, 'yellow');
        }
    } else {
        const symlinkPath = path.join(os.homedir(), '.local', 'bin', 'agent-lens');
        try {
            if (fs.existsSync(symlinkPath) && fs.lstatSync(symlinkPath).isSymbolicLink()) {
                fs.unlinkSync(symlinkPath);
                log(`[OK] 已移除命令链接: ${symlinkPath}`, 'green');
            }
        } catch (error) {
            log(`[WARN] 清理命令链接失败: ${error.message}`, 'yellow');
        }
    }

    // 3. 从所有支持工具移除 hooks 配置与 Codex 信任状态
    log('清理 Claude Code、Codex 和 Cursor Hooks 配置...', 'cyan');
    try {
        const installedHookManager = path.join(INSTALL_DIR, 'install-hooks.js');
        const hookManager = fs.existsSync(installedHookManager)
            ? installedHookManager
            : path.join(__dirname, 'install-hooks.js');
        execFileSync(process.execPath, [hookManager, '--uninstall'], { stdio: 'inherit', windowsHide: true });
    } catch (e) {
        log(`[WARN] 清理配置失败: ${e.message}`, 'yellow');
    }

    // 4. 删除安装根目录
    log(`删除目录: ${INSTALL_ROOT}`, 'cyan');
    if (fs.existsSync(INSTALL_ROOT)) {
        rimraf(INSTALL_ROOT);
        log('[OK] 目录已删除', 'green');
    } else {
        log('[SKIP] 目录不存在', 'dim');
    }

    // 5. npm unlink -g
    log('执行 npm unlink -g agent-lens ...', 'cyan');
    try {
        execSync('npm unlink -g @z7ping/agent-lens', { stdio: 'ignore', windowsHide: true });
        try { execSync('npm unlink -g agent-lens', { stdio: 'ignore', windowsHide: true }); } catch (_) {}
        log('[OK] 全局链接已移除', 'green');
    } catch (_) {
        log('[SKIP] 未找到全局链接', 'dim');
    }

    console.log('');
    log('═'.repeat(45), 'dim');
    log('卸载完成！', 'bright');
    log('═'.repeat(45), 'dim');
}

// ─── status 命令 ─────────────────────────────────────────────────

async function cmdStatus(baseDir) {
    baseDir = baseDir || INSTALL_DIR;
    const pid = readPid(baseDir);
    if (pid && isProcessAlive(pid)) {
        log(`✅ 运行中  PID: ${pid}  端口: ${DEFAULT_PORT}`, 'green');
    } else {
        if (pid) {
            try { fs.unlinkSync(getPidFile(baseDir)); } catch (_) {}
        }
        if (await isPortListening(DEFAULT_PORT)) {
            log(`⚠️ 端口 ${DEFAULT_PORT} 已被占用，但 AgentLens PID 文件缺失或已过期`, 'yellow');
        } else {
            log('未运行', 'yellow');
        }
    }
}

// ─── 安装与迁移辅助函数 ──────────────────────────────────────────

function ensureFrontendBuild(projectDir) {
    const distIndex = path.join(projectDir, 'dist', 'index.html');
    if (fs.existsSync(distIndex)) return;
    log('dist/ 不存在，正在构建前端...', 'yellow');
    execSync('npm run build', { cwd: projectDir, stdio: 'inherit', windowsHide: true });
    if (!fs.existsSync(distIndex)) throw new Error('前端构建完成后仍缺少 dist/index.html');
}

function installRuntimeDependencies(appDir) {
    execSync('npm install --omit=dev --no-audit --no-fund --package-lock=false --registry=https://registry.npmjs.org/', {
        cwd: appDir,
        stdio: 'inherit',
        windowsHide: true,
    });

    const nativeProbe = "const Database=require('better-sqlite3');const db=new Database(':memory:');db.close()";
    try {
        execFileSync(process.execPath, ['-e', nativeProbe], { cwd: appDir, stdio: 'ignore', windowsHide: true });
        return { backend: 'better-sqlite3' };
    } catch (_) {
        log('检测到 better-sqlite3 不可用，正在尝试批准并重建...', 'yellow');
    }

    try {
        try {
            execSync('npm install-scripts approve better-sqlite3', { cwd: appDir, stdio: 'inherit', windowsHide: true });
        } catch (_) {
            // 旧版 npm 没有 install-scripts 子命令，直接尝试 rebuild。
        }
        execSync('npm rebuild better-sqlite3 --foreground-scripts', { cwd: appDir, stdio: 'inherit', windowsHide: true });
        execFileSync(process.execPath, ['-e', nativeProbe], { cwd: appDir, stdio: 'ignore', windowsHide: true });
        return { backend: 'better-sqlite3' };
    } catch (_) {
        try {
            execFileSync(process.execPath, ['-e', "require.resolve('sql.js')"], { cwd: appDir, stdio: 'ignore', windowsHide: true });
            log('[WARN] better-sqlite3 不可用，将使用 sql.js 回退', 'yellow');
            return { backend: 'sql.js' };
        } catch (error) {
            throw new Error(`SQLite 运行依赖不可用: ${error.message}`);
        }
    }
}

function readPidFile(pidFile) {
    try {
        if (!fs.existsSync(pidFile)) return null;
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch (_) {
        return null;
    }
}

function stopPidFile(pidFile, label) {
    const pid = readPidFile(pidFile);
    if (!pid) return false;
    if (!isProcessAlive(pid)) {
        try { fs.unlinkSync(pidFile); } catch (_) {}
        return false;
    }
    try {
        process.kill(pid, 'SIGTERM');
        try { fs.unlinkSync(pidFile); } catch (_) {}
        log(`[OK] 已停止${label}进程 (PID: ${pid})`, 'green');
        return true;
    } catch (error) {
        log(`[WARN] 无法停止${label}进程 ${pid}: ${error.message}`, 'yellow');
        return false;
    }
}

function stopKnownWindowsRuntimeProcesses() {
    if (!isWin()) return [];
    const knownRoots = [...new Set([
        INSTALL_ROOT,
        LEGACY_INSTALL_RUNTIME_PATHS.rootDir,
    ].map(value => path.resolve(value).replace(/\\/g, '/').toLowerCase()))];
    const script = [
        '$roots = ConvertFrom-Json $env:AGENT_LENS_KNOWN_ROOTS_JSON',
        '$currentPid = [int]$env:AGENT_LENS_CURRENT_PID',
        'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $currentPid -and $_.CommandLine } | ForEach-Object {',
        '  $command = ($_.CommandLine -replace "\\\\", "/").ToLowerInvariant()',
        '  $matched = $false',
        '  $isRuntime = $command.Contains("/hooks/") -or $command -match "server\\.js" -or $command -match "cli\\.js.+start"',
        '  if ($isRuntime) { foreach ($root in $roots) { if ($command.Contains([string]$root)) { $matched = $true; break } } }',
        '  if ($matched) { Stop-Process -Id $_.ProcessId -Force; Write-Output $_.ProcessId }',
        '}',
    ].join('\n');
    try {
        const output = execFileSync('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            script,
        ], {
            env: {
                ...process.env,
                AGENT_LENS_KNOWN_ROOTS_JSON: JSON.stringify(knownRoots),
                AGENT_LENS_CURRENT_PID: String(process.pid),
            },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
        });
        return output.split(/\r?\n/).map(value => parseInt(value.trim(), 10)).filter(Number.isInteger);
    } catch (_) {
        return [];
    }
}

async function stopProcessesForUpgrade() {
    const backend = getServiceBackend();
    if (backend === 'systemd' || backend === 'launchd') {
        try { platformAction('stop'); } catch (_) {}
    }
    stopPidFile(INSTALL_RUNTIME_PATHS.pidFile, '当前安装');
    if (path.resolve(LEGACY_INSTALL_RUNTIME_PATHS.pidFile) !== path.resolve(INSTALL_RUNTIME_PATHS.pidFile)) {
        stopPidFile(LEGACY_INSTALL_RUNTIME_PATHS.pidFile, '旧版安装');
    }
    const stoppedWindowsPids = stopKnownWindowsRuntimeProcesses();
    if (stoppedWindowsPids.length > 0) {
        log(`[OK] 已清理旧版 Windows 运行进程: ${stoppedWindowsPids.join(', ')}`, 'green');
    }
    if (!await waitForPortClosed(DEFAULT_PORT, 10000)) {
        throw new Error(`端口 ${DEFAULT_PORT} 仍被占用，请先停止占用该端口的进程`);
    }
}

function isWindowsPathLockError(error) {
    return error && ['EBUSY', 'EPERM', 'EACCES'].includes(error.code);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function activateStagedApplicationForUpgrade(stagedAppDir) {
    const maxAttempts = isWin() ? WINDOWS_ACTIVATION_MAX_ATTEMPTS : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (isWin()) stopKnownWindowsRuntimeProcesses();
        try {
            return activateStagedApplication(stagedAppDir, INSTALL_DIR, INSTALL_ROOT);
        } catch (error) {
            if (!isWin() || !isWindowsPathLockError(error) || attempt === maxAttempts) throw error;
            if (attempt === 1) log('[WARN] 已安装目录仍被 Hook 或服务占用，正在等待释放...', 'yellow');
            await delay(WINDOWS_ACTIVATION_RETRY_DELAY_MS);
        }
    }

    return null;
}

async function rollbackInstalledApplication(backupDir) {
    if (!backupDir || !fs.existsSync(backupDir)) return { restored: false, running: false };

    log('正在恢复上一版程序...', 'yellow');
    try {
        try {
            await stopProcessesForUpgrade();
        } catch (error) {
            log(`[WARN] 回滚前停止失败服务时出现问题: ${error.message}`, 'yellow');
        }

        const restored = restoreBackupApplication(backupDir, INSTALL_DIR, INSTALL_ROOT);
        if (!restored) return { restored: false, running: false };
        removeTree(path.join(INSTALL_ROOT, '.rollback'));
        log('[OK] 上一版程序已恢复', 'green');

        syncInstalledHooks('上一版 Hooks 配置恢复失败');

        let launchedByService = false;
        try {
            launchedByService = platformAction('start') !== false;
        } catch (error) {
            log(`[WARN] 上一版系统服务启动失败，将回退到 daemon: ${error.message}`, 'yellow');
        }
        if (!launchedByService) startInstalledDaemon(DEFAULT_PORT);

        const running = await waitForInstalledDaemon(
            DEFAULT_PORT,
            INSTALL_READY_TIMEOUT_MS,
            readInstalledVersion(),
        );
        if (running) log(`[OK] 上一版服务已恢复 → http://localhost:${DEFAULT_PORT}/`, 'green');
        else log('[WARN] 上一版程序已恢复，但服务需要手动启动', 'yellow');
        return { restored: true, running };
    } catch (error) {
        log(`[ERROR] 自动回滚失败: ${error.message}`, 'red');
        return { restored: false, running: false };
    }
}

function setWindowsUserPath(binDir, removeOnly = false) {
    const userPath = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'PATH'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
    }).trim();
    const pathMatch = userPath.match(/PATH\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
    const currentParts = pathMatch ? pathMatch[1].trim().split(';').filter(Boolean) : [];
    const obsoletePaths = new Set([
        INSTALL_ROOT,
        INSTALL_DIR,
        FLAT_INSTALL_RUNTIME_PATHS.appDir,
        LEGACY_INSTALL_RUNTIME_PATHS.rootDir,
        LEGACY_INSTALL_RUNTIME_PATHS.appDir,
        INSTALL_BIN_DIR,
    ].map(value => path.resolve(value).toLowerCase()));
    const retained = currentParts.filter(value => {
        try { return !obsoletePaths.has(path.resolve(value).toLowerCase()); }
        catch (_) { return true; }
    });
    const newParts = removeOnly ? retained : [binDir, ...retained];
    const newPath = newParts.join(';');
    execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        "[Environment]::SetEnvironmentVariable('Path', $env:AGENT_LENS_NEW_PATH, 'User')",
    ], {
        env: { ...process.env, AGENT_LENS_NEW_PATH: newPath },
        stdio: 'ignore',
        windowsHide: true,
    });
    return currentParts.join(';').toLowerCase() !== newPath.toLowerCase();
}

function createCommandEntry() {
    const cliPath = path.join(INSTALL_DIR, 'cli.js');
    if (isWin()) {
        mkdirp(INSTALL_BIN_DIR);
        const batPath = path.join(INSTALL_BIN_DIR, 'agent-lens.cmd');
        const hookRunnerSource = path.join(INSTALL_DIR, 'hooks', 'windows-hook-runner.exe');
        const hookRunnerPath = path.join(INSTALL_BIN_DIR, WINDOWS_HOOK_RUNNER_NAME);
        if (!fs.existsSync(hookRunnerSource)) {
            throw new Error(`缺少 Windows 无窗口 Hook 启动器: ${hookRunnerSource}`);
        }
        fs.copyFileSync(hookRunnerSource, hookRunnerPath);
        const batContent = `@echo off\r\n"${process.execPath}" "${cliPath}" %*\r\n`;
        fs.writeFileSync(batPath, batContent, 'utf8');
        log(`[OK] 已创建: ${batPath}、${hookRunnerPath}`, 'green');
        try {
            const pathChanged = setWindowsUserPath(INSTALL_BIN_DIR);
            if (pathChanged) log('  PATH 已更新，请重启终端后使用 agent-lens', 'dim');
        } catch (error) {
            log(`[WARN] 自动更新 PATH 失败: ${error.message}`, 'yellow');
            log(`  请手动添加: ${INSTALL_BIN_DIR}`, 'dim');
        }
        return batPath;
    }

    const localBin = path.join(os.homedir(), '.local', 'bin');
    mkdirp(localBin);
    const symlinkPath = path.join(localBin, 'agent-lens');
    if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
    fs.symlinkSync(cliPath, symlinkPath);
    fs.chmodSync(cliPath, 0o755);
    log(`[OK] 已创建链接: ${symlinkPath}`, 'green');
    if (!process.env.PATH.includes(localBin)) log(`[WARN] 请确保 ${localBin} 在 PATH 中`, 'yellow');
    return symlinkPath;
}

// ─── package 命令 ────────────────────────────────────────────────

function cmdPackage(argv = []) {
    const outputFlagIdx = argv.indexOf('--output');
    const outputDir = outputFlagIdx >= 0 && argv[outputFlagIdx + 1]
        ? path.resolve(argv[outputFlagIdx + 1])
        : path.join(PROJECT_DIR, 'dist');

    log(`📦 打包 AgentLens v${getVersion()}`, 'bright');
    log('═'.repeat(45), 'dim');
    console.log('');

    mkdirp(outputDir);

    if (!fs.existsSync(path.join(PROJECT_DIR, 'dist', 'index.html'))) {
        log('dist/ 不存在，正在构建前端...', 'yellow');
        execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'inherit', windowsHide: true });
    }

    log('使用 npm pack 生成可复现分发包...', 'cyan');
    const before = new Set(fs.readdirSync(outputDir));
    execSync(`npm pack --pack-destination "${outputDir}"`, {
        cwd: PROJECT_DIR,
        stdio: 'inherit',
        windowsHide: true,
    });
    const created = fs.readdirSync(outputDir)
        .filter(name => !before.has(name) && /^z7ping-agent-lens-.+\.tgz$/.test(name))
        .sort();
    const archiveName = created[created.length - 1] || `z7ping-agent-lens-${getVersion()}.tgz`;

    console.log('');
    log('═'.repeat(45), 'dim');
    log('打包完成！', 'bright');
    console.log('');
    log(`输出: ${path.join(outputDir, archiveName)}`, 'cyan');
    console.log('');
    log('分发方式:', 'yellow');
    log('  1. 上传 .tgz 到 GitHub Releases', 'dim');
    log('  2. 用户运行: npx ./z7ping-agent-lens-x.y.z.tgz install', 'dim');
    log('  3. 或发布到 npm 后运行: npx @z7ping/agent-lens install', 'dim');
    log('═'.repeat(45), 'dim');
}

// ─── help 命令 ───────────────────────────────────────────────────

function showHelp() {
    log('🧠 AgentLens CLI', 'bright');
    console.log('');
    log('用法:', 'yellow');
    log('  agent-lens <command> [options]', 'cyan');
    console.log('');
    log('命令:', 'yellow');
    log('  install                       安装应用、依赖和 hooks，并启动服务', 'dim');
    log('  start [port] [options]        启动服务器（默认端口 56789）', 'dim');
    log('  stop                          停止后台服务', 'dim');
    log('  status                        查看默认服务状态', 'dim');
    log('  service <subcommand>          管理系统服务或 daemon', 'dim');
    log('  package [--output <dir>]      构建并生成 npm 兼容分发包', 'dim');
    log('  uninstall                     卸载并清理所有配置和数据', 'dim');
    log('  help, --help, -h              显示此帮助', 'dim');
    console.log('');
    log('service 子命令:', 'yellow');
    log('  service install               注册后台服务并启用自启', 'dim');
    log('  service uninstall             停止并移除后台服务', 'dim');
    log('  service start                 启动服务', 'dim');
    log('  service stop                  停止服务', 'dim');
    log('  service enable                启用开机自启', 'dim');
    log('  service disable               关闭开机自启', 'dim');
    log('  service status                查看服务、自启、版本和运行环境', 'dim');
    console.log('');
    log('start 选项:', 'yellow');
    log('  --daemon, -d                  后台守护进程模式', 'dim');
    log('  --port <port>                 指定端口，也可直接使用位置参数', 'dim');
    log('  --open                        启动后自动打开浏览器', 'dim');
    console.log('');
    log('package 选项:', 'yellow');
    log('  --output <dir>                指定 .tgz 输出目录（默认 dist/）', 'dim');
    console.log('');
    log('平台说明:', 'yellow');
    log('  Linux:  systemd user service，支持全部 service 子命令', 'dim');
    log('  macOS:  launchd agent，支持全部 service 子命令', 'dim');
    log('  Windows: 当前用户启动目录，登录时自动启动，无需管理员权限', 'dim');
    log('           支持全部 service 子命令', 'dim');
    log('  status 当前固定检查默认端口 56789', 'dim');
    console.log('');
    log('示例:', 'yellow');
    log('  agent-lens install', 'dim');
    log('  agent-lens start --daemon', 'dim');
    log('  agent-lens start --port 8080 --open', 'dim');
    log('  agent-lens service status', 'dim');
    log('  agent-lens package --output ./release', 'dim');
    log('  agent-lens uninstall', 'dim');
}

// ─── 主入口 ──────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const cmdArgs = args.slice(1);

    switch (command) {
        case 'install':
            await cmdInstall();
            break;
        case 'start':
            // start 命令使用项目目录（cli.js 所在目录）
            cmdStart(cmdArgs);
            break;
        case 'stop':
            cmdStop(PROJECT_DIR);
            break;
        case 'uninstall':
            await cmdUninstall();
            break;
        case 'service':
            await Promise.resolve(cmdService(cmdArgs[0]));
            break;
        case 'status':
            await cmdStatus(PROJECT_DIR);
            break;
        case 'package':
            cmdPackage(cmdArgs);
            break;
        case 'help':
        case '--help':
        case '-h':
            showHelp();
            break;
        default:
            if (command) {
                log(`未知命令: ${command}`, 'red');
                console.log('');
            }
            showHelp();
            break;
    }
}

main().catch((error) => {
    log(`[ERROR] ${error.message}`, 'red');
    process.exitCode = 1;
});
