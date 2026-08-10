#!/usr/bin/env node
/**
 * Server Guard - 共享模块：检测/启动/停止 HTTP 服务
 *
 * 供 prelog.js 钩子和 install.sh 使用
 * 通过 PID 文件 + TCP 检测双重验证服务状态
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const { DEFAULT_PORT } = require('../config');
const { ensureRuntimeDirs, getRuntimePaths } = require('../runtime-paths');

/**
 * 获取 PID 文件路径
 */
function getPidFile(baseDir) {
    const runtimePaths = getRuntimePaths({ baseDir });
    ensureRuntimeDirs(runtimePaths);
    return runtimePaths.pidFile;
}

/**
 * 读取保存的 PID
 */
function readPid(baseDir) {
    try {
        const pidFile = getPidFile(baseDir);
        if (fs.existsSync(pidFile)) {
            const content = fs.readFileSync(pidFile, 'utf-8').trim();
            const pid = parseInt(content, 10);
            if (!isNaN(pid) && pid > 0) return pid;
        }
    } catch (_) {}
    return null;
}

/**
 * 检查进程是否存活
 */
function isProcessAlive(pid) {
    try {
        // process.kill(pid, 0) 不发送信号，仅检测进程是否存在
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * TCP 连接检测端口是否被占用（< 500ms 超时）
 */
function checkPort(port, callback) {
    const socket = new net.Socket();
    let responded = false;

    socket.setTimeout(500);

    socket.on('connect', () => {
        responded = true;
        socket.destroy();
        callback(true);
    });

    socket.on('timeout', () => {
        if (!responded) {
            responded = true;
            socket.destroy();
            callback(false);
        }
    });

    socket.on('error', () => {
        if (!responded) {
            responded = true;
            socket.destroy();
            callback(false);
        }
    });

    socket.connect(port, '127.0.0.1');
}

/**
 * 检测服务是否运行中（同步方式，读 PID 文件）
 * 注意：不做 TCP 检测（同步阻塞），仅验证 PID 存活
 */
function isServerRunningSync(baseDir) {
    const pid = readPid(baseDir);
    if (pid && isProcessAlive(pid)) return true;
    return false;
}

/**
 * 检测服务是否运行中（异步，含 TCP 检测）
 * @param {string} baseDir - 项目根目录
 * @param {number} port - 端口号
 * @returns {Promise<boolean>}
 */
function isServerRunning(baseDir, port) {
    return new Promise((resolve) => {
        // 先检查 PID 文件
        const pid = readPid(baseDir);
        if (pid && isProcessAlive(pid)) {
            return resolve(true);
        }

        // 回退：TCP 检测（PID 文件可能丢失但进程还在）
        checkPort(port || DEFAULT_PORT, (inUse) => {
            resolve(inUse);
        });
    });
}

/**
 * 获取服务状态
 */
function getServerStatus(baseDir, port) {
    const pid = readPid(baseDir);
    if (pid && isProcessAlive(pid)) {
        return { running: true, pid: pid };
    }
    return { running: false, pid: null };
}

/**
 * 确保服务运行中（非阻塞）
 * - 已运行：什么都不做
 * - 未运行：spawn 后台守护进程，立即返回
 */
function ensureServerRunning(baseDir, port) {
    port = port || DEFAULT_PORT;

    // 快速同步检查 PID 文件
    if (isServerRunningSync(baseDir)) return;

    // TCP 检查（异步但不等待结果——仅在可能需要启动时才做）
    checkPort(port, (inUse) => {
        if (inUse) return; // 端口已被占用（可能是另一个实例）

        // 启动守护进程
        const serverPath = path.join(baseDir, 'server.js');
        if (!fs.existsSync(serverPath)) return;

        try {
            // 统一使用 cli.js 启动（跨平台）
            const cliPath = path.join(baseDir, 'cli.js');
            if (fs.existsSync(cliPath)) {
                spawn('node', [cliPath, 'start', '--daemon', '--port', String(port)], {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true,
                }).unref();
            } else {
                // 备用启动路径：直接使用 server.js
                const child = spawn('node', [serverPath, String(port), '--daemon'], {
                    detached: true,
                    stdio: ['ignore', 'ignore', 'ignore'],
                    cwd: baseDir,
                });
                child.unref();
            }
        } catch (_) {
            // 启动失败，静默忽略
        }
    });
}

/**
 * 停止服务
 */
function stopServer(baseDir) {
    const pid = readPid(baseDir);
    if (!pid) {
        return { success: false, message: '未找到 PID 文件' };
    }

    try {
        process.kill(pid, 'SIGTERM');
        // 清理 PID 文件
        const pidFile = getPidFile(baseDir);
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
        return { success: true, message: `已发送 SIGTERM 到 PID ${pid}` };
    } catch (e) {
        if (e.code === 'ESRCH') {
            // 进程不存在，清理 PID 文件
            const pidFile = getPidFile(baseDir);
            if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
            return { success: true, message: `进程 ${pid} 已不存在，已清理 PID 文件` };
        }
        return { success: false, message: e.message };
    }
}

// 导出（供其他模块 require）
module.exports = {
    isServerRunning,
    isServerRunningSync,
    ensureServerRunning,
    getServerStatus,
    stopServer,
    getPidFile,
};

// CLI 入口：node server-guard.js --status / --stop
if (require.main === module) {
    const BASE_DIR = path.join(__dirname, '..');
    const args = process.argv.slice(2);
    const cmd = args[0];

    if (cmd === '--status') {
        const status = getServerStatus(BASE_DIR, DEFAULT_PORT);
        if (status.running) {
            console.log(`运行中 (PID: ${status.pid})`);
        } else {
            console.log('未运行');
        }
    } else if (cmd === '--stop') {
        const result = stopServer(BASE_DIR);
        console.log(result.message);
    } else if (cmd === '--ensure') {
        ensureServerRunning(BASE_DIR, DEFAULT_PORT);
        console.log('已触发检查');
    } else {
        console.log('用法: node server-guard.js [--status|--stop|--ensure]');
    }
}
