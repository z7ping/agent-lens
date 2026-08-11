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
const { ensureRuntimeDirs, getRuntimePaths } = require('./runtime-paths');

// ─── 配置 ────────────────────────────────────────────────────────

const IS_SOURCE_LAYOUT = path.basename(__dirname) === 'server';
const PROJECT_DIR = IS_SOURCE_LAYOUT ? path.dirname(__dirname) : __dirname;
const CURRENT_RUNTIME_PATHS = getRuntimePaths({ baseDir: __dirname });
const INSTALL_RUNTIME_PATHS = getRuntimePaths({ layout: 'installed' });
const INSTALL_ROOT = INSTALL_RUNTIME_PATHS.rootDir;
const INSTALL_DIR = INSTALL_RUNTIME_PATHS.appDir;
const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');
const { DEFAULT_PORT } = require('./config');
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
        execSync('node --version', { stdio: 'ignore' });
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

function copyFile(src, dest) {
    if (fs.existsSync(src)) {
        mkdirp(path.dirname(dest));
        fs.copyFileSync(src, dest);
    }
}

function rimraf(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function copyDir(src, dest) {
    if (!fs.existsSync(src)) return;
    mkdirp(dest);
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
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
    const installedCli = path.join(INSTALL_DIR, 'cli.js');
    const installedServer = path.join(INSTALL_DIR, 'server.js');
    if (fs.existsSync(installedCli)) {
        const child = spawn(process.execPath, [installedCli, 'start', '--daemon', '--port', String(port)], {
            cwd: INSTALL_DIR,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        child.unref();
        return;
    }
    const child = spawn(process.execPath, [installedServer, String(port), '--daemon'], {
        cwd: INSTALL_DIR,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.unref();
}

function isHttpReady(port) {
    return new Promise((resolve) => {
        const req = http.get({
            hostname: '127.0.0.1',
            port,
            path: '/api/app-info',
            timeout: 1000,
        }, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 500);
        });
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.on('error', () => resolve(false));
    });
}

async function waitForInstalledDaemon(port, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pid = readPid(INSTALL_DIR);
        if (((pid && isProcessAlive(pid)) || await isPortListening(port)) && await isHttpReady(port)) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return false;
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

function platformAction(action) {
    const backend = getServiceBackend();
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

function cmdService(subcmd) {
    switch (subcmd) {
        case 'install':   return platformAction('install');
        case 'uninstall': return platformAction('uninstall');
        case 'start':     return platformAction('start');
        case 'stop':      return platformAction('stop');
        case 'enable':    return platformAction('enable');
        case 'disable':   return platformAction('disable');
        case 'status':    return platformAction('status');
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

    // 1. 检查 Node.js
    if (!checkNodeAvailable()) {
        log('[ERROR] 未找到 Node.js', 'red');
        log('请安装 Node.js: https://nodejs.org/', 'yellow');
        process.exit(1);
    }
    log('[OK] Node.js 可用', 'green');

    // 2. 创建目录
    console.log('');
    log(`创建目录: ${INSTALL_ROOT}`, 'cyan');
    ensureRuntimeDirs(INSTALL_RUNTIME_PATHS);

    // 初始化 projects.json
    const projectsJson = INSTALL_RUNTIME_PATHS.projectsFile;
    if (!fs.existsSync(projectsJson)) {
        fs.writeFileSync(projectsJson, '{}', 'utf-8');
    }

    // 3. 复制文件
    if (path.resolve(PROJECT_DIR) === path.resolve(INSTALL_DIR)) {
        log('源目录 = 目标目录，跳过复制', 'yellow');
    } else {
        log('复制文件...', 'cyan');

        // hooks/
        const hooks = ['prelog.js', 'log.js', 'server-guard.js'];
        hooks.forEach(f => {
            copyFile(path.join(PROJECT_DIR, 'server', 'hooks', f), path.join(INSTALL_DIR, 'hooks', f));
        });

        // server/ 根目录文件
        const rootFiles = [
            'server.js', 'cli.js', 'db.js', 'config.js', 'runtime-paths.js', 'agent-lens-db.js', 'paths.js',
            'install-hooks.js', 'schema.sql', 'routes.js', 'tool-map.js', 'overview.js', 'sources-status.js',
            'app-info.js'
        ];
        rootFiles.forEach(f => {
            copyFile(path.join(PROJECT_DIR, 'server', f), path.join(INSTALL_DIR, f));
        });

        // importers/ (历史导入器，server.js 运行时需要)
        const importersDir = path.join(PROJECT_DIR, 'server', 'importers');
        if (fs.existsSync(importersDir)) {
            copyDir(importersDir, path.join(INSTALL_DIR, 'importers'));
        }

        // package.json（npm install 需要）
        copyFile(path.join(PROJECT_DIR, 'package.json'), path.join(INSTALL_DIR, 'package.json'));
        copyFile(path.join(PROJECT_DIR, 'CHANGELOG.md'), path.join(INSTALL_DIR, 'CHANGELOG.md'));
        copyFile(path.join(PROJECT_DIR, 'README.md'), path.join(INSTALL_DIR, 'README.md'));

        // adapters/
        const adapters = fs.readdirSync(path.join(PROJECT_DIR, 'server', 'adapters')) || [];
        adapters.forEach(f => {
            copyFile(path.join(PROJECT_DIR, 'server', 'adapters', f), path.join(INSTALL_DIR, 'adapters', f));
        });

        // dist/ (Vite 构建产物)
        if (fs.existsSync(path.join(PROJECT_DIR, 'dist'))) {
            copyDir(path.join(PROJECT_DIR, 'dist'), path.join(INSTALL_DIR, 'dist'));
            log(`  dist/ 已复制`, 'dim');
        } else {
            log('  dist/ 不存在，正在构建前端...', 'yellow');
            try {
                execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'inherit' });
                if (fs.existsSync(path.join(PROJECT_DIR, 'dist'))) {
                    copyDir(path.join(PROJECT_DIR, 'dist'), path.join(INSTALL_DIR, 'dist'));
                    log(`  dist/ 已构建并复制`, 'green');
                }
            } catch (e) {
                log('[WARN] 前端构建失败，请手动运行: npm run build', 'yellow');
                log('  然后重新安装或手动复制 dist/ 到目标目录', 'dim');
            }
        }

        log(`[OK] 文件已复制`, 'green');
    }

    // 4. 安装依赖
    if (path.resolve(PROJECT_DIR) !== path.resolve(INSTALL_DIR)) {
        console.log('');
        log('安装依赖...', 'cyan');
        try {
            execSync('npm install', { cwd: INSTALL_DIR, stdio: 'inherit' });
            try {
                execFileSync(process.execPath, ['-e', "const Database=require('better-sqlite3');const db=new Database(':memory:');db.close()"], {
                    cwd: INSTALL_DIR,
                    stdio: 'ignore',
                });
            } catch (_) {
                log('检测到原生依赖安装脚本被阻止，正在批准并重建...', 'yellow');
                try {
                    execSync('npm install-scripts approve better-sqlite3 esbuild', { cwd: INSTALL_DIR, stdio: 'inherit' });
                } catch (_) {
                    // 旧版 npm 没有 install-scripts 子命令，直接尝试 rebuild。
                }
                execSync('npm rebuild better-sqlite3 esbuild --foreground-scripts', { cwd: INSTALL_DIR, stdio: 'inherit' });
                execFileSync(process.execPath, ['-e', "const Database=require('better-sqlite3');const db=new Database(':memory:');db.close()"], {
                    cwd: INSTALL_DIR,
                    stdio: 'ignore',
                });
            }
            log('[OK] 依赖安装完成', 'green');
        } catch (e) {
            log('[WARN] 依赖安装失败，请手动运行: npm install', 'yellow');
            log('  Windows 可能需要: npm install -g node-gyp-windows', 'dim');
            log('  或安装 Visual Studio Build Tools', 'dim');
        }
    }

    // 5. 更新 settings.json
    console.log('');
    log(`更新配置: ${SETTINGS_FILE}`, 'cyan');
    try {
        execSync(`node "${path.join(INSTALL_DIR, 'install-hooks.js')}"`, {
            stdio: 'inherit',
        });
    } catch (e) {
        log('[WARN] 更新 settings.json 失败', 'yellow');
    }

    // 6. 创建可执行入口
    const cliPath = path.join(INSTALL_DIR, 'cli.js');
    if (isWin()) {
        // Windows: 创建 batch 脚本 + 自动加入 PATH
        const batPath = path.join(INSTALL_DIR, 'agent-lens.cmd');
        const nodeExe = process.execPath;
        const batContent = `@echo off
"${nodeExe}" "${cliPath}" %*
        `;
        try {
            fs.writeFileSync(batPath, batContent, 'utf-8');
            // 自动加入用户 PATH
            const userPath = execSync('reg query HKCU\\Environment /v PATH 2>nul', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
            const pathMatch = userPath.match(/PATH\s+REG_(?:EXPAND_)?SZ\s+(.+)/);
            const currentPath = pathMatch ? pathMatch[1].trim() : '';
            if (!currentPath.split(';').some(p => p.toLowerCase() === INSTALL_DIR.toLowerCase())) {
                const newPath = currentPath ? `${INSTALL_DIR};${currentPath}` : INSTALL_DIR;
                execFileSync('powershell.exe', [
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-Command',
                    "[Environment]::SetEnvironmentVariable('Path', $env:AGENT_LENS_NEW_PATH, 'User')",
                ], {
                    env: { ...process.env, AGENT_LENS_NEW_PATH: newPath },
                    stdio: 'ignore',
                });
                log(`[OK] 已创建: ${batPath}`, 'green');
                log(`[OK] 已加入 PATH: ${INSTALL_DIR}`, 'green');
                log('  请重启终端后使用 "agent-lens" 命令', 'dim');
            } else {
                log(`[OK] 已创建: ${batPath} (已在 PATH 中)`, 'green');
            }
        } catch (e) {
            log(`[OK] 已创建: ${batPath}`, 'green');
            log(`[WARN] 自动加入 PATH 失败（可能需要管理员权限）`, 'yellow');
            log(`  手动添加: 右键此电脑 → 属性 → 高级系统设置 → 环境变量 → Path → 新建`, 'dim');
            log(`  路径: ${INSTALL_DIR}`, 'dim');
        }
    } else {
        // Unix: 创建符号链接到 ~/.local/bin（XDG 规范）
        const localBin = path.join(os.homedir(), '.local', 'bin');
        mkdirp(localBin);
        const symlinkPath = path.join(localBin, 'agent-lens');
        try {
            if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
            fs.symlinkSync(cliPath, symlinkPath);
            fs.chmodSync(cliPath, 0o755);
            log(`[OK] 已创建链接: ${symlinkPath}`, 'green');
            if (!process.env.PATH.includes(localBin)) {
                log(`[WARN] 请确保 ${localBin} 在 PATH 中`, 'yellow');
            }
        } catch (e) {
            log(`[WARN] 创建链接失败: ${e.message}`, 'yellow');
        }
    }

    // 7. 注册系统服务并启动
    console.log('');
    log('配置系统服务...', 'cyan');
    const serviceReady = platformAction('install');

    if (serviceReady !== false) {
        const backend = getServiceBackend();
        // Windows 重新安装时必须重启旧 daemon，否则内存中仍是旧版本代码。
        if (backend === 'windows-startup') {
            cmdStop(INSTALL_DIR);
            await waitForPortClosed(DEFAULT_PORT);
        }
        // 启动服务
        platformAction('start');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 检查状态
        let running = false;
        if (backend === 'systemd') {
            try {
                running = execSync(`systemctl --user is-active ${SERVICE_NAME} 2>/dev/null`, { encoding: 'utf-8' }).trim() === 'active';
            } catch {}
        } else if (backend === 'launchd') {
            try {
                const out = execSync(`launchctl list | grep ${SERVICE_LABEL}`, { encoding: 'utf-8' }).trim();
                running = out && !out.split(/\s+/)[0] === '-';
            } catch {}
        } else if (backend === 'windows-startup') {
            // 首次加载 SQLite 和多数据源适配器可能超过 2 秒，等待完整 HTTP 就绪。
            running = await waitForInstalledDaemon(DEFAULT_PORT, 15000);
        }

        if (running) {
            log(`[OK] 服务已启动 → http://localhost:${DEFAULT_PORT}/`, 'green');
        } else {
            log('[WARN] 服务未启动，请手动运行:', 'yellow');
            log(`  agent-lens service start`, 'dim');
        }
    } else {
        // 无可用服务后端，回退到 daemon 模式
        log('回退到 daemon 模式...', 'yellow');
        try {
            cmdStop(INSTALL_DIR);
            startInstalledDaemon(DEFAULT_PORT);
            if (await waitForInstalledDaemon(DEFAULT_PORT)) {
                log(`[OK] 服务已启动 → http://localhost:${DEFAULT_PORT}/`, 'green');
            } else {
                log('[WARN] 服务未启动，请手动运行:', 'yellow');
                log(`  agent-lens start --daemon`, 'dim');
            }
        } catch (_) {
            log('[WARN] 自动启动失败，请手动运行:', 'yellow');
            log(`  agent-lens start --daemon`, 'dim');
        }
    }

    // 8. 完成提示
    console.log('');
    log('═'.repeat(45), 'dim');
    log('安装完成！', 'bright');
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
                execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'ignore' });
            } catch (_) {}
        } else {
            console.log('');
            log('📦 正在构建前端，请稍候...', 'bright');
            log('  （首次启动需要，后续启动直接使用缓存）', 'dim');
            console.log('');
            const startTime = Date.now();
            try {
                execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'inherit' });
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
    const serverJsPosix = serverJsPath.replace(/\\/g, '/');

    if (isDaemon) {
        // 守护进程模式
        if (isWin()) {
            // Windows: 使用 VBScript 隐藏窗口
            const vbsContent = [
                'Set objShell = CreateObject("WScript.Shell")',
                `objShell.CurrentDirectory = "${PROJECT_DIR.replace(/\\/g, '/')}"`,
                `objShell.Run "cmd.exe /c start /b node ""${serverJsPosix}"" ${port} --daemon", 0, False`,
            ].join('\r\n');
            const vbsPath = path.join(os.tmpdir(), 'agent-lens-daemon.vbs');
            fs.writeFileSync(vbsPath, vbsContent, 'utf-8');
            try {
                execSync(`wscript "${vbsPath}"`, { stdio: 'ignore' });
            } finally {
                try { fs.unlinkSync(vbsPath); } catch (_) {}
            }
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

    // 2. 从 settings.json 移除 hooks 配置
    log(`清理配置: ${SETTINGS_FILE}`, 'cyan');
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
            if (settings.hooks) {
                const agentLensMarker = 'agent-lens';
                function removeAgentLensHooks(hookArray) {
                    if (!Array.isArray(hookArray)) return [];
                    return hookArray.filter(entry => {
                        if (!entry || !entry.hooks) return true;
                        return !entry.hooks.some(h => h.command && h.command.includes(agentLensMarker));
                    });
                }
                settings.hooks.PreToolUse = removeAgentLensHooks(settings.hooks.PreToolUse);
                settings.hooks.PostToolUse = removeAgentLensHooks(settings.hooks.PostToolUse);
                // Clean up empty hook arrays
                if ((!settings.hooks.PreToolUse || settings.hooks.PreToolUse.length === 0) &&
                    (!settings.hooks.PostToolUse || settings.hooks.PostToolUse.length === 0)) {
                    delete settings.hooks;
                }
                fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
                log('[OK] agent-lens hooks 配置已移除', 'green');
            } else {
                log('[SKIP] 未找到 hooks 配置', 'dim');
            }
        } else {
            log('[SKIP] settings.json 不存在', 'dim');
        }
    } catch (e) {
        log(`[WARN] 清理配置失败: ${e.message}`, 'yellow');
    }

    // 3. 删除安装根目录
    log(`删除目录: ${INSTALL_ROOT}`, 'cyan');
    if (fs.existsSync(INSTALL_ROOT)) {
        rimraf(INSTALL_ROOT);
        log('[OK] 目录已删除', 'green');
    } else {
        log('[SKIP] 目录不存在', 'dim');
    }

    // 4. npm unlink -g
    log('执行 npm unlink -g agent-lens ...', 'cyan');
    try {
        execSync('npm unlink -g @z7ping/agent-lens', { stdio: 'ignore' });
        try { execSync('npm unlink -g agent-lens', { stdio: 'ignore' }); } catch (_) {}
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
            log(`✅ 运行中  端口: ${DEFAULT_PORT}（PID 文件缺失或已过期）`, 'green');
        } else {
            log('未运行', 'yellow');
        }
    }
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
        execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'inherit' });
    }

    log('使用 npm pack 生成可复现分发包...', 'cyan');
    const before = new Set(fs.readdirSync(outputDir));
    execSync(`npm pack --pack-destination "${outputDir}"`, {
        cwd: PROJECT_DIR,
        stdio: 'inherit',
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
    log('  service status                查看服务和自启状态', 'dim');
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

function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const cmdArgs = args.slice(1);

    switch (command) {
        case 'install':
            cmdInstall();
            break;
        case 'start':
            // start 命令使用项目目录（cli.js 所在目录）
            cmdStart(cmdArgs);
            break;
        case 'stop':
            cmdStop(PROJECT_DIR);
            break;
        case 'uninstall':
            cmdUninstall();
            break;
        case 'service':
            cmdService(cmdArgs[0]);
            break;
        case 'status':
            cmdStatus(PROJECT_DIR);
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

main();
