import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_DEV_PORT = 56789
export const DEV_PORT_ATTEMPTS = 21

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

export function buildDevEnvironment(baseEnv, repoRoot, port) {
  const paths = devRuntimePaths(repoRoot, port)
  return {
    ...baseEnv,
    AGENT_LENS_PORT: String(port),
    AGENT_LENS_DB_PATH: paths.dbPath,
    AGENT_LENS_VAULT_PATH: paths.vaultPath,
    AGENT_LENS_DAEMON_MODE: 'foreground',
    AGENT_LENS_RUNTIME_OWNER: 'cli',
  }
}

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

export async function runDevRuntime() {
  const currentFile = fileURLToPath(import.meta.url)
  const repoRoot = resolve(dirname(currentFile), '..')
  const startPort = parseDevPort(process.env.AGENT_LENS_DEV_PORT)
  const port = await findAvailableDevPort(startPort)
  const paths = devRuntimePaths(repoRoot, port)

  await mkdir(paths.dataRoot, { recursive: true })

  if (port === startPort) {
    console.info(`[AgentLens] 开发运行时端口：${port}`)
  } else {
    console.info(`[AgentLens] 开发端口 ${startPort} 已占用，自动退避到 ${port}`)
  }
  console.info(`[AgentLens] 开发数据目录：${paths.dataRoot}`)
  console.info(`[AgentLens] 开发 Web/UI：http://127.0.0.1:${port}`)

  const child = spawn(
    npmExecutable(),
    ['run', 'dev', '--workspace', '@agent-lens/daemon'],
    {
      cwd: repoRoot,
      env: buildDevEnvironment(process.env, repoRoot, port),
      stdio: 'inherit',
      windowsHide: false,
    },
  )

  child.once('error', error => {
    console.error('[AgentLens] 开发运行时启动失败', error)
    process.exitCode = 1
  })

  child.once('exit', (code, signal) => {
    if (signal) {
      console.info(`[AgentLens] 开发运行时已退出（signal=${signal}）`)
      return
    }
    process.exitCode = code ?? 0
  })
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runDevRuntime().catch(error => {
    console.error('[AgentLens] 开发运行时启动失败', error)
    process.exitCode = 1
  })
}
