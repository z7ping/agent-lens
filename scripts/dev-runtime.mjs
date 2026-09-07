import { execFileSync, spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 正式安装态固定使用 56789；源码开发使用独立端口，避免已安装桌面端
// 将开发 Runtime 误识别为可复用的正式 Runtime。
export const DEFAULT_DEV_PORT = 56800
export const DEV_PORT_ATTEMPTS = 21
// 历史量较大的源码数据库需要完成 SQLite 打开/迁移后才能监听 HTTP。
// 30 秒对冷启动过于激进；仍可通过环境变量收紧或放宽。
export const DEV_RUNTIME_READY_TIMEOUT_MS = 120_000
export const DEV_RUNTIME_READY_INTERVAL_MS = 100

function devLog(message, ...details) {
  const stamp = new Date().toISOString()
  console.info(`[AgentLens][dev][${stamp}] ${message}`, ...details)
}

export function parseDevPort(value, fallback = DEFAULT_DEV_PORT) {
  if (value === undefined || value === null || value === '') return fallback
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`AGENT_LENS_DEV_PORT 必须是 1-65535 的整数，当前值：${String(value)}`)
  }
  return port
}

export function devRuntimePaths(repoRoot, port) {
  const dataRoot = join(repoRoot, '.agent-lens', 'dev', String(port))
  return {
    dataRoot,
    dbPath: join(dataRoot, 'agent-lens.db'),
    vaultPath: join(dataRoot, 'vault'),
  }
}

export function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', error => {
      if (error && typeof error === 'object' && 'code' in error
        && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) {
        resolvePort(false)
        return
      }
      reject(error)
    })
    server.listen({ host, port, exclusive: true }, () => {
      server.close(error => {
        if (error) reject(error)
        else resolvePort(true)
      })
    })
  })
}

export async function findAvailableDevPort(
  startPort,
  attempts = DEV_PORT_ATTEMPTS,
  probe = isPortAvailable,
) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('attempts 必须 >= 1')

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset
    if (port > 65535) break
    if (await probe(port)) return port
  }

  const endPort = Math.min(65535, startPort + attempts - 1)
  throw new Error(`开发端口 ${startPort}-${endPort} 均不可用，请释放端口或设置 AGENT_LENS_DEV_PORT 指定新的起始端口。`)
}

export async function waitForRuntimeReady(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEV_RUNTIME_READY_TIMEOUT_MS,
    intervalMs = DEV_RUNTIME_READY_INTERVAL_MS,
    signal,
  } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 运行时不支持 fetch')
  const deadline = Date.now() + timeoutMs
  let lastError
  let attempts = 0

  while (!signal?.aborted && Date.now() < deadline) {
    attempts += 1
    try {
      const remainingMs = Math.max(1, deadline - Date.now())
      const requestTimeout = AbortSignal.timeout(Math.min(5_000, remainingMs))
      const response = await fetchImpl(url, {
        signal: signal ? AbortSignal.any([signal, requestTimeout]) : requestTimeout,
      })
      if (response.ok) {
        devLog(`Runtime 就绪探测成功（第 ${attempts} 次，耗时 ${timeoutMs - Math.max(0, deadline - Date.now())}ms）`)
        return
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await new Promise(resolveDelay => setTimeout(resolveDelay, intervalMs))
  }

  if (signal?.aborted) throw new Error('开发 Runtime 就绪等待已取消')
  const detail = lastError instanceof Error ? `：${lastError.message}` : ''
  devLog(`Runtime 就绪探测超时（${attempts} 次，最后错误${detail || '未知'}）`)
  throw new Error(`开发 Runtime 在 ${timeoutMs}ms 内未就绪${detail}`)
}

export function buildDevEnvironment(baseEnv, repoRoot, port) {
  const paths = devRuntimePaths(repoRoot, port)
  return {
    ...baseEnv,
    AGENT_LENS_PORT: String(port),
    AGENT_LENS_DEV_API_PORT: String(port),
    AGENT_LENS_DB_PATH: paths.dbPath,
    AGENT_LENS_VAULT_PATH: paths.vaultPath,
    AGENT_LENS_DAEMON_MODE: 'foreground',
    AGENT_LENS_RUNTIME_OWNER: 'cli',
  }
}

export function npmInvocation(env = process.env, workspace = '@agent-lens/daemon') {
  if (env.npm_execpath) {
    return {
      command: process.execPath,
      args: [env.npm_execpath, 'run', 'dev', '--workspace', workspace],
    }
  }
  if (process.platform === 'win32') {
    return {
      command: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `npm run dev --workspace ${workspace}`],
    }
  }
  return {
    command: 'npm',
    args: ['run', 'dev', '--workspace', workspace],
  }
}

function startWorkspaceDev(repoRoot, env, workspace) {
  const invocation = npmInvocation(env, workspace)
  return spawn(invocation.command, invocation.args, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
    windowsHide: false,
  })
}

function stopChild(child) {
  if (!child || child.killed || child.exitCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch {
    // 退出阶段尽力停止；具体子进程也会收到终端信号。
  }
  // Windows 下 npm 会再创建 cmd.exe 和 node 子进程，ChildProcess.kill 只
  // 结束 npm 顶层进程，留下的 Daemon 会继续占用开发端口。按 PID 回收
  // 整棵由本次启动创建的进程树，避免下一次启动命中不可用的残留 Runtime。
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      // 子进程可能已自行退出；退出阶段不因清理失败覆盖原始错误。
    }
  }
}

function parseReadyTimeout(value) {
  if (value === undefined || value === null || value === '') return DEV_RUNTIME_READY_TIMEOUT_MS
  const timeout = Number(value)
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > tenMinutesMs) {
    throw new Error(`AGENT_LENS_DEV_READY_TIMEOUT_MS 必须是 1000-${tenMinutesMs} 毫秒的整数，当前值：${String(value)}`)
  }
  return timeout
}

const tenMinutesMs = 10 * 60 * 1_000

export async function runDevRuntime() {
  const startedAt = Date.now()
  devLog('启动流程开始')
  const currentFile = fileURLToPath(import.meta.url)
  const repoRoot = resolve(dirname(currentFile), '..')
  const startPort = parseDevPort(process.env.AGENT_LENS_DEV_PORT)
  const readyTimeoutMs = parseReadyTimeout(process.env.AGENT_LENS_DEV_READY_TIMEOUT_MS)
  const port = await findAvailableDevPort(startPort)
  const paths = devRuntimePaths(repoRoot, port)
  const devEnv = buildDevEnvironment(process.env, repoRoot, port)

  await mkdir(paths.dataRoot, { recursive: true })

  if (port === startPort) {
    console.info(`[AgentLens] 开发运行时端口：${port}`)
  } else {
    console.info(`[AgentLens] 开发端口 ${startPort} 已占用，自动退避到 ${port}`)
  }
  console.info(`[AgentLens] 开发数据目录：${paths.dataRoot}`)
  console.info(`[AgentLens] 开发 API：http://127.0.0.1:${port}`)
  console.info('[AgentLens] 开发 Web：Runtime 就绪后启动 Vite（默认 http://127.0.0.1:5173）')
  console.info(`[AgentLens] Vite /api 代理：http://127.0.0.1:${port}`)

  const daemon = startWorkspaceDev(repoRoot, devEnv, '@agent-lens/daemon')
  devLog(`Daemon 子进程已创建（pid=${daemon.pid ?? 'unknown'}）`)
  const children = [daemon]
  const startupController = new AbortController()
  let shuttingDown = false

  const stopAll = () => {
    if (shuttingDown) return
    shuttingDown = true
    startupController.abort()
    children.forEach(stopChild)
  }

  const onSignal = signal => {
    console.info(`[AgentLens] 开发环境收到 ${signal}，正在停止 Web 与 Daemon`)
    stopAll()
  }
  process.once('SIGINT', () => onSignal('SIGINT'))
  process.once('SIGTERM', () => onSignal('SIGTERM'))

  const monitorChild = (child, label) => {
    child.once('error', error => {
      console.error(`[AgentLens] 开发 ${label} 启动失败`, error)
      process.exitCode = 1
      stopAll()
    })
    child.once('exit', (code, signal) => {
      if (!shuttingDown && (code ?? 0) !== 0) {
        console.error(`[AgentLens] 开发 ${label} 异常退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`)
        process.exitCode = code ?? 1
        stopAll()
      }
    })
  }

  monitorChild(daemon, 'Daemon')

  try {
    await waitForRuntimeReady(`http://127.0.0.1:${port}/api/v1/ready`, {
      signal: startupController.signal,
      timeoutMs: readyTimeoutMs,
    })
  } catch (error) {
    if (shuttingDown) return
    stopAll()
    throw error
  }

  console.info('[AgentLens] Runtime API 已就绪，正在启动 Vite')
  const web = startWorkspaceDev(repoRoot, devEnv, '@agent-lens/web')
  devLog(`Vite 子进程已创建（pid=${web.pid ?? 'unknown'}，Runtime 就绪耗时 ${Date.now() - startedAt}ms）`)
  children.push(web)
  monitorChild(web, 'Web')

  await Promise.all(children.map(child => (
    child.exitCode !== null
      ? Promise.resolve()
      : new Promise(resolveDone => child.once('exit', resolveDone))
  )))
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runDevRuntime().catch(error => {
    console.error('[AgentLens] 开发环境启动失败', error)
    process.exitCode = 1
  })
}
