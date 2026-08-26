import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createServer } from 'node:net'

function argNumber(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length)
  const parsed = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`无效参数 --${name}=${raw}`)
  return parsed
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index] ?? 0
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('无法分配本地端口'))
        return
      }
      const port = address.port
      server.close(error => error ? reject(error) : resolvePort(port))
    })
  })
}

async function waitForHealth(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok || response.status === 503) return
    } catch { /* daemon is still starting */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Daemon 未在 ${timeoutMs}ms 内进入 Health 可访问状态`)
}

function linuxCpuTicks(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  const userTicks = Number(tail[11])
  const systemTicks = Number(tail[12])
  if (!Number.isFinite(userTicks) || !Number.isFinite(systemTicks)) throw new Error('无法解析 /proc CPU 统计')
  return userTicks + systemTicks
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(resolveExit => child.once('exit', () => resolveExit())),
    new Promise<void>(resolveDelay => setTimeout(resolveDelay, 3000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

if (process.platform !== 'linux') {
  throw new Error('Daemon 空闲 CPU 正式基准当前使用 /proc，仅在 Linux Performance Runner 执行')
}

const samples = Math.floor(argNumber('samples', 6))
const windowMs = argNumber('window-ms', 1000)
const settleMs = argNumber('settle-ms', 2500)
const budgetP95Percent = argNumber('budget-p95-percent', 5)
const clockTicks = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
if (!Number.isFinite(clockTicks) || clockTicks <= 0) throw new Error('无法读取 Linux CLK_TCK')

const root = await mkdtemp(join(tmpdir(), 'agent-lens-idle-cpu-'))
const home = join(root, 'home')
await mkdir(home, { recursive: true })
const port = await freePort()
const daemonEntry = resolve('dist/daemon.mjs')
const child = spawn(process.execPath, [daemonEntry], {
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AGENT_LENS_DB_PATH: join(root, 'agent-lens.db'),
    AGENT_LENS_VAULT_PATH: join(root, 'vault'),
    AGENT_LENS_PORT: String(port),
    AGENT_LENS_DAEMON_MODE: 'managed',
    AGENT_LENS_RUNTIME_OWNER: 'service',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})

try {
  if (!child.pid) throw new Error('Daemon 子进程没有 PID')
  await waitForHealth(port)
  await new Promise(resolveDelay => setTimeout(resolveDelay, settleMs))

  const values: number[] = []
  for (let index = 0; index < samples; index += 1) {
    const beforeTicks = linuxCpuTicks(child.pid)
    const startedAt = performance.now()
    await new Promise(resolveDelay => setTimeout(resolveDelay, windowMs))
    const elapsedMs = performance.now() - startedAt
    const afterTicks = linuxCpuTicks(child.pid)
    const cpuSeconds = (afterTicks - beforeTicks) / clockTicks
    values.push(cpuSeconds / (elapsedMs / 1000) * 100)
  }

  const p50 = percentile(values, 0.5)
  const p95 = percentile(values, 0.95)
  const average = values.reduce((sum, value) => sum + value, 0) / values.length
  const max = Math.max(...values)
  console.log(`[AgentLens perf] Daemon 空闲 CPU samples=${samples} window=${windowMs}ms P50=${p50.toFixed(2)}% P95=${p95.toFixed(2)}% avg=${average.toFixed(2)}% max=${max.toFixed(2)}% budget=${budgetP95Percent}%`)
  console.log(JSON.stringify({ benchmark: 'daemon-idle-cpu', samples, windowMs, settleMs, p50Percent: p50, p95Percent: p95, averagePercent: average, maxPercent: max, budgetP95Percent }))

  if (p95 > budgetP95Percent) {
    throw new Error(`Daemon 空闲 CPU P95 ${p95.toFixed(2)}% 超过预算 ${budgetP95Percent}%`)
  }
} finally {
  await stopChild(child)
  await rm(root, { recursive: true, force: true })
}
