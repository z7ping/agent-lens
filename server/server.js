#!/usr/bin/env node
/**
 * AgentLens - HTTP 服务器
 *
 * 用法:
 *   node server.js [port]              # 前台运行
 *   node server.js [port] --daemon     # 后台守护进程
 *   node server.js --open              # 前台运行 + 自动打开浏览器
 *   node server.js --stop              # 停止守护进程
 *   node server.js --status            # 查看运行状态
 *
 * 默认端口: 56789（定义在 config.js）
 *
 * 特点:
 * - 可选依赖 better-sqlite3（用于仪表盘 API）
 * - 守护进程模式：后台运行，PID 文件管理
 * - 自动打开浏览器
 * - 默认仅监听本机回环地址并校验同源请求
 * - 彩色终端输出
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const net = require('net');
const { ensureRuntimeDirs, getRuntimePaths } = require('./runtime-paths');
const {
    allowedOrigins,
    isPathInside,
    validateLocalRequest,
    applySecurityHeaders,
    getOrCreateHookToken,
    validateHookToken,
    readJsonBody,
} = require('./security');

// ─── 命令行参数解析 ──────────────────────────────────────────

const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
const positional = args.filter(a => !a.startsWith('--'));

const isDaemon = flags.includes('--daemon');
const shouldOpen = flags.includes('--open');
const shouldStop = flags.includes('--stop');
const shouldStatus = flags.includes('--status');

// 端口：第一个非 flag 参数，或环境变量，或默认 56789
const PORT = parseInt(positional[0], 10) || parseInt(process.env.TRACKER_PORT, 10) || require('./config').DEFAULT_PORT;
const HOST = require('./config').DEFAULT_HOST;
const RUNTIME_PATHS = getRuntimePaths({ baseDir: __dirname });
ensureRuntimeDirs(RUNTIME_PATHS);
const DIR = fs.existsSync(RUNTIME_PATHS.distDir) ? RUNTIME_PATHS.distDir : RUNTIME_PATHS.appDir;
const PID_FILE = RUNTIME_PATHS.pidFile;
const PROJECT_REGISTRY_FILES = [
    RUNTIME_PATHS.projectsFile,
];
const HOOK_TOKEN = getOrCreateHookToken(RUNTIME_PATHS.hookTokenFile);
const ALLOWED_ORIGINS = allowedOrigins(PORT);

// ─── 彩色输出 ────────────────────────────────────────────────

const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
    // 守护进程模式不输出日志到 stdout
    if (isDaemon) return;
    console.log(`${colors[color]}${message}${colors.reset}`);
}

// ─── PID 管理 ────────────────────────────────────────────────

function writePid() {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
}

function removePid() {
    try {
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    } catch (_) {}
}

function readPid() {
    try {
        if (fs.existsSync(PID_FILE)) {
            const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
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

// ─── TCP 端口检测 ────────────────────────────────────────────

function checkPortInUse(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let responded = false;
        socket.setTimeout(500);
        socket.on('connect', () => { responded = true; socket.destroy(); resolve(true); });
        socket.on('timeout', () => { if (!responded) { responded = true; socket.destroy(); resolve(false); } });
        socket.on('error', () => { if (!responded) { responded = true; socket.destroy(); resolve(false); } });
        socket.connect(port, '127.0.0.1');
    });
}

// ─── --stop 命令 ─────────────────────────────────────────────

function handleStop() {
    const pid = readPid();
    if (!pid) {
        console.log('未找到运行中的服务（无 PID 文件）');
        process.exit(0);
    }
    if (!isProcessAlive(pid)) {
        console.log(`进程 ${pid} 已不存在，清理 PID 文件`);
        removePid();
        process.exit(0);
    }
    try {
        process.kill(pid, 'SIGTERM');
        removePid();
        console.log(`已停止服务 (PID: ${pid})`);
    } catch (e) {
        console.error(`停止失败: ${e.message}`);
        process.exit(1);
    }
}

// ─── --status 命令 ───────────────────────────────────────────

function handleStatus() {
    const pid = readPid();
    if (pid && isProcessAlive(pid)) {
        console.log(`运行中  PID: ${pid}  端口: ${PORT}`);
    } else {
        if (pid) removePid(); // 清理过期 PID
        console.log('未运行');
    }
}

// ─── 自动打开浏览器 ──────────────────────────────────────────

function openBrowser(url) {
    try {
        const platform = process.platform;
        if (platform === 'win32') {
            execSync(`start "" "${url}"`, { stdio: 'ignore' });
        } else if (platform === 'darwin') {
            execSync(`open "${url}"`, { stdio: 'ignore' });
        } else {
            execSync(`xdg-open "${url}" 2>/dev/null || true`, { stdio: 'ignore' });
        }
    } catch (_) {}
}

// ─── 处理 stop / status ─────────────────────────────────────

if (shouldStop) { handleStop(); process.exit(0); }
if (shouldStatus) { handleStatus(); process.exit(0); }

// ─── 端口冲突检测 ────────────────────────────────────────────

async function main() {
    // 检查 PID 文件中的进程是否存活
    const existingPid = readPid();
    if (existingPid && isProcessAlive(existingPid)) {
        if (isDaemon) {
            // 守护模式下已运行，静默退出
            process.exit(0);
        } else {
            log(`⚠️  服务已在运行 (PID: ${existingPid})`, 'yellow');
            log(`   访问 http://localhost:${PORT}/`, 'cyan');
            log(`   如需重启: node server.js --stop`, 'dim');
            process.exit(0);
        }
    }

    // 清理过期 PID 文件
    if (existingPid && !isProcessAlive(existingPid)) {
        removePid();
    }

    // 检查端口是否被其他进程占用
    const portInUse = await checkPortInUse(PORT);
    if (portInUse) {
        if (isDaemon) {
            process.exit(0);
        }
        log(`⚠️  端口 ${PORT} 已被占用`, 'yellow');
        log(`   尝试其他端口: node server.js 8081`, 'dim');
        process.exit(1);
    }

    // ─── MIME 类型映射 ──────────────────────────────────────────

    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
    };

    // ─── agent-lens.db 集成 ─────────────────────────────────────
    const trackerDb = require('./agent-lens-db');

    function getDb() {
        try {
            const d = trackerDb.getDb();
            return d;
        } catch (e) {
            console.error('[getDb] Error:', e.message);
            return null;
        }
    }

    // ─── API 处理函数 ──────────────────────────────────────────

    const { handleApiStats, handleApiTools, handleApiSessions, handleApiTimeline, handleApiSkills, handleApiCompare, handleApiErrors, handleApiToolMap, handleApiSourcesStatus, handleApiCapabilities, handleApiOverview, handleApiAppInfo, handleApiProjects } = require('./routes');

    function sendJson(res, data, statusCode = 200) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
    }

    // ─── 处理 Hermes 插件推送的 hook 数据 ──────────────────────
    function handleHookData(data) {
        const crypto = require('crypto');
        const { insertTimeline, updateDailyStats, saveError, recomputeSession } = require('./agent-lens-db');
        const { makeEventId } = require('./event-model');

        const source = data.source || 'hermes';
        const toolName = data.tool_name || '';
        const cwd = data.cwd || '';
        const sessionId = data.session_id || '';
        const durationMs = data.duration_ms || 0;
        const success = data.success !== false;
        const inputSummary = data.input_summary || {};
        const errorMsg = data.error || null;

        // 计算 project_key (MD5 of cwd, first 12 chars)
        const projectKey = crypto.createHash('md5').update(cwd || process.cwd()).digest('hex').substring(0, 12);
        const ts = new Date().toISOString();
        const callId = data.call_id || data.tool_use_id || data.source_event_id || crypto.randomUUID();
        const useEventId = makeEventId({ source, session_id: sessionId, event_type: 'tool_use', call_id: callId });

        insertTimeline({
            event_id: useEventId,
            source,
            session_id: sessionId,
            timestamp: data.started_at || ts,
            source_event_id: data.source_event_id || callId,
            source_sequence: data.seq ?? null,
            seq: data.seq ?? null,
            event_type: 'tool_use',
            role: 'tool_use',
            call_id: callId,
            tool_use_id: callId,
            tool_name: toolName,
            content: null,
            tool_input: JSON.stringify(inputSummary),
            success: null,
            exit_code: null,
            duration_ms: null,
            output_snippet: null,
            error_message: null,
            error_type: null,
            error_detail: null,
            project_key: projectKey,
            parent_seq: data.parent_seq ?? null,
            parent_event_id: data.parent_event_id || null,
            agent_id: data.agent_id || null,
            turn_id: data.turn_id || null,
            capture_method: 'runtime_hook',
            visibility: 'captured',
            confidence: data.call_id || data.tool_use_id ? 'confirmed' : 'partial',
            missing_reason: data.call_id || data.tool_use_id ? null : '推送数据未提供稳定调用标识',
        });

        const resultInfo = insertTimeline({
            source,
            session_id: sessionId,
            timestamp: ts,
            source_event_id: data.source_event_id || callId,
            source_sequence: data.seq ?? null,
            seq: data.seq ?? null,
            event_type: success ? 'tool_result' : 'tool_error',
            role: success ? 'tool_result' : 'tool_error',
            call_id: callId,
            tool_use_id: callId,
            parent_event_id: useEventId,
            tool_name: toolName,
            tool_input: JSON.stringify(inputSummary),
            success: success ? 1 : 0,
            duration_ms: durationMs,
            error_message: errorMsg,
            project_key: projectKey,
            parent_seq: data.parent_seq ?? null,
            agent_id: data.agent_id || null,
            turn_id: data.turn_id || null,
            capture_method: 'runtime_hook',
            visibility: 'captured',
            confidence: data.call_id || data.tool_use_id ? 'confirmed' : 'partial',
            missing_reason: data.call_id || data.tool_use_id ? null : '推送数据未提供稳定调用标识',
        });

        if (resultInfo.changes > 0) {
            const date = ts.slice(0, 10);
            updateDailyStats(date, source, toolName, 1, success ? 0 : 1, durationMs);
            if (!success && errorMsg) saveError(ts, sessionId, source, toolName, errorMsg);
        }
        recomputeSession(source, sessionId, projectKey);
    }

    // ─── 创建 HTTP 服务器 ──────────────────────────────────────

    function readMergedProjects() {
        const projects = {};
        for (const file of PROJECT_REGISTRY_FILES) {
            try {
                if (!fs.existsSync(file)) continue;
                const content = fs.readFileSync(file, 'utf-8').trim();
                if (!content) continue;
                Object.assign(projects, JSON.parse(content));
            } catch (_) {}
        }
        return projects;
    }

    function readFallbackFile(urlPath, callback) {
        const cleanPath = urlPath.replace(/^\/+/, '');
        const candidates = [];
        if (cleanPath.startsWith('logs/')) {
            candidates.push({ base: RUNTIME_PATHS.logsDir, file: path.resolve(path.join(RUNTIME_PATHS.logsDir, cleanPath.slice('logs/'.length))) });
        } else if (cleanPath.startsWith('states/')) {
            candidates.push({ base: RUNTIME_PATHS.stateDir, file: path.resolve(path.join(RUNTIME_PATHS.stateDir, cleanPath.slice('states/'.length))) });
        }

        const readNext = (index) => {
            if (index >= candidates.length) {
                callback(new Error('ENOENT'));
                return;
            }

            const { base, file: candidate } = candidates[index];
            if (!isPathInside(base, candidate)) {
                readNext(index + 1);
                return;
            }

            fs.readFile(candidate, (err, content) => {
                if (err) readNext(index + 1);
                else callback(null, content);
            });
        };

        readNext(0);
    }

    const server = http.createServer((req, res) => {
        let urlPath = req.url.split('?')[0];
        const urlParams = new URL(req.url, `http://localhost:${PORT}`).searchParams;

        const requestCheck = validateLocalRequest(req, { port: PORT, origins: ALLOWED_ORIGINS });
        applySecurityHeaders(res, requestCheck.origin);
        if (!requestCheck.ok) {
            sendJson(res, { error: requestCheck.message }, requestCheck.status);
            return;
        }

        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Methods', urlPath === '/api/hook' ? 'POST, OPTIONS' : 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AgentLens-Token, Authorization');
            res.setHeader('Access-Control-Max-Age', '600');
            res.writeHead(204);
            res.end();
            return;
        }

        if (urlPath.startsWith('/api/')) {
            const allowedMethod = urlPath === '/api/hook' ? 'POST' : 'GET';
            if (req.method !== allowedMethod) {
                res.setHeader('Allow', allowedMethod);
                sendJson(res, { error: `该接口只允许 ${allowedMethod}` }, 405);
                return;
            }
        } else if (!['GET', 'HEAD'].includes(req.method)) {
            res.setHeader('Allow', 'GET, HEAD');
            sendJson(res, { error: '静态资源只允许读取' }, 405);
            return;
        }

        // ─── API 路由 ──────────────────────────────────────────
        
        if (urlPath === '/api/stats') {
            handleApiStats(req, res, urlParams);
            return;
        }
        
        if (urlPath === '/api/tools') {
            handleApiTools(req, res, urlParams);
            return;
        }

        if (urlPath === '/api/tool-map') {
            handleApiToolMap(req, res, urlParams);
            return;
        }

        if (urlPath === '/api/overview') {
            handleApiOverview(req, res, urlParams);
            return;
        }

        if (urlPath === '/api/app-info') {
            handleApiAppInfo(req, res);
            return;
        }

        if (urlPath === '/api/projects') {
            handleApiProjects(req, res, urlParams);
            return;
        }
        
        if (urlPath === '/api/sessions') {
            handleApiSessions(req, res, urlParams);
            return;
        }
        
        if (urlPath === '/api/timeline') {
            handleApiTimeline(req, res, urlParams);
            return;
        }

        if (urlPath === '/api/skills') {
            handleApiSkills(req, res, urlParams);
            return;
        }

        if (urlPath === '/api/compare') {
            handleApiCompare(req, res);
            return;
        }

        // ─── POST /api/hook — 接收 Hermes 插件推送的工具调用数据 ───
        if (urlPath === '/api/hook') {
            if (!validateHookToken(req, HOOK_TOKEN)) {
                sendJson(res, { error: 'Hook 写入令牌无效' }, 401);
                return;
            }
            readJsonBody(req)
                .then(data => {
                    handleHookData(data);
                    sendJson(res, { ok: true });
                })
                .catch(error => sendJson(res, { error: error.message }, error.statusCode || 400));
            return;
        }

        if (urlPath === '/api/errors') {
            handleApiErrors(req, res, urlParams);
            return;
        }

        if (urlPath === '/api/sources/status') {
            handleApiSourcesStatus(req, res, urlParams);
            return;
        }

        if (urlPath === '/api/capabilities') {
            handleApiCapabilities(req, res);
            return;
        }

        // ─── 静态文件服务 ──────────────────────────────────────
        
        if (urlPath === '/') urlPath = '/index.html';

        if (urlPath === '/projects.json') {
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-cache',
            });
            res.end(JSON.stringify(readMergedProjects()));
            log(`  200 ${req.method} ${urlPath}`, 'green');
            return;
        }

        const filePath = path.resolve(path.join(DIR, urlPath));
        const ext = path.extname(filePath).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        // 安全检查：防止目录遍历（使用 path.resolve 解析后比对）
        if (!isPathInside(DIR, filePath)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        fs.readFile(filePath, (err, content) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    // 回退到运行时目录（logs/、state/ 等数据文件）
                    readFallbackFile(urlPath, (err2, content2) => {
                        if (err2) {
                            res.writeHead(404, { 'Content-Type': 'text/plain' });
                            res.end('404 Not Found');
                            log(`  404 ${req.method} ${urlPath}`, 'red');
                        } else {
                            res.writeHead(200, { 'Content-Type': contentType });
                            res.end(content2);
                            log(`  200 ${req.method} ${urlPath}`, 'green');
                        }
                    });
                } else {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('500 Internal Server Error');
                    log(`  500 ${req.method} ${urlPath}`, 'red');
                }
            } else {
                res.writeHead(200, {
                    'Content-Type': `${contentType}; charset=utf-8`,
                    'Cache-Control': 'no-cache',
                });
                res.end(content);
                log(`  200 ${req.method} ${urlPath}`, 'green');
            }
        });
    });

    // ─── 初始化数据库后端 ──────────────────────────────────────

    async function initDb() {
        // agent-lens.db 已自动初始化，无需额外 ready()
        try {
            const d = getDb();
            if (d) {
                log(`  ✅ 数据库就绪 (better-sqlite3)`, 'green');
                try {
                    const { startOverviewScanner } = require('./overview');
                    const { DEFAULT_OVERVIEW_SCAN_INTERVAL_MS } = require('./config');
                    const timer = startOverviewScanner(d);
                    if (timer) log(`  ✅ 概览资产定时扫描已启动 (${Math.round(DEFAULT_OVERVIEW_SCAN_INTERVAL_MS / 1000)}s)`, 'green');
                    else log(`  ℹ️ 概览资产定时扫描已关闭`, 'dim');
                } catch (e) {
                    log(`  ⚠️ 概览资产扫描启动失败: ${e.message}`, 'yellow');
                }
            }
        } catch (e) {
            log(`  ⚠️ 数据库初始化失败: ${e.message}`, 'yellow');
        }

        // 启动需要轮询的适配器
        try {
            const { getAdapter } = require('./adapters');
            // Claude Code 统一由版本化 JSONL 导入器处理，避免双路径重复写入。
            const pollingAdapters = ['opencode', 'pi'];
            for (const name of pollingAdapters) {
                const adapter = getAdapter(name);
                if (adapter && adapter.startPolling) {
                    adapter.startPolling();
                    log(`  ✅ ${name} 轮询已启动`, 'green');
                }
            }

        } catch (e) {
            log(`  ⚠️ 轮询启动失败: ${e.message}`, 'yellow');
        }

        // 启动 JSONL 历史导入器（Claude Code / Codex 历史记录回填）
        try {
            const { startAll } = require('./importers');
            startAll();
            log(`  ✅ JSONL 历史导入已启动 (claude-code/codex)`, 'green');
        } catch (e) {
            log(`  ⚠️ JSONL 历史导入启动失败: ${e.message}`, 'yellow');
        }
    }

    // ─── 启动服务器 ────────────────────────────────────────────

    initDb().then(() => {
        server.listen(PORT, HOST, () => {
            // 写入 PID 文件
            writePid();

            if (!isDaemon) {
                console.log('');
                log('🧠 AgentLens - HTTP 服务器', 'bright');
                log('========================================', 'dim');
                console.log('');
                log(`✅ 服务器已启动`, 'green');
                log(`📂 服务目录: ${DIR}`, 'cyan');
                log(`🌐 访问地址: http://${HOST}:${PORT}/`, 'cyan');
                log(`📋 PID: ${process.pid}`, 'dim');
                console.log('');
                log('📋 可用功能:', 'yellow');
                log('   • 顶部下拉框切换项目', 'dim');
                log('   • 点击"自动"按钮实时监控', 'dim');
                log('   • 支持搜索、过滤、暗色主题', 'dim');
                console.log('');
                log('💡 管理命令:', 'dim');
                log('   node server.js --stop    停止服务', 'dim');
                log('   node server.js --status  查看状态', 'dim');
                log('   按 Ctrl+C 停止服务器', 'dim');
                log('========================================', 'dim');
                console.log('');
            }

            // 自动打开浏览器（仅前台模式或显式 --open）
            if (shouldOpen || (!isDaemon && process.env.TRACKER_AUTO_OPEN !== '0')) {
                const url = `http://localhost:${PORT}/`;
                // 延迟 500ms 等服务器完全就绪
                setTimeout(() => openBrowser(url), 500);
            }

            // 启动 hermes timeline 收集（延迟执行避免阻塞）
            setTimeout(() => {
                try {
                    const { getAdapter: ga } = require('./adapters');
                    const hermesAdapter = ga('hermes');
                    if (hermesAdapter && hermesAdapter.startCollecting) {
                        hermesAdapter.startCollecting();
                        log(`  ✅ hermes timeline 收集已启动`, 'green');
                    }
                } catch (e) {
                    log(`  ⚠️ hermes 收集启动失败: ${e.message}`, 'yellow');
                }
            }, 1000);
        });

        // ─── 优雅关闭 ──────────────────────────────────────────────

        function shutdown() {
            try {
                const { stopAll } = require('./adapters');
                stopAll();
            } catch (_) {}
            try {
                const { stopAll: stopImporters } = require('./importers');
                stopImporters();
            } catch (_) {}
            try {
                const { stopOverviewScanner } = require('./overview');
                stopOverviewScanner();
            } catch (_) {}
            try {
                const agentLensDb = require('./agent-lens-db');
                agentLensDb.closeDb();
            } catch (_) {}
            removePid();
            if (!isDaemon) {
                console.log('');
                log('👋 服务器已停止', 'yellow');
            }
            process.exit(0);
        }

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // 守护进程：退出时清理
        process.on('exit', removePid);
    });
}

main();
