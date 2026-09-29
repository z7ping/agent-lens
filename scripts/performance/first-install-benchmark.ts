import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { readPositiveInt } from './benchmark-utils'

// 独立用户目录、空数据库和正式 Daemon；不复用已有摘要或真实用户历史。
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const root = await mkdtemp(join(tmpdir(), 'agent-lens-first-install-'))
const codexHome = join(root, '.codex')
const sessionsDirectory = join(codexHome, 'sessions')
const sessions = readPositiveInt('sessions', 1_000)
const observationsPerSession = readPositiveInt('observations-per-session', 20)
const budgetMs = readPositiveInt('budget-ms', 3_000)
const timeoutMs = readPositiveInt('timeout-ms', 30_000)
const onboarding = process.argv.includes('--onboarding')
const distribution = process.argv.includes('--dist')
let child: ChildProcess | undefined
let output = ''
const eventsController = new AbortController()
let eventsTask: Promise<void> | undefined

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法取得隔离端口')
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function stopDaemon(): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const stopped = new Promise<void>(resolve => { child!.once('exit', () => resolve()) })
  if (child.connected) child.send('benchmark:shutdown')
  else child.kill()
  const fallback = setTimeout(() => child?.kill(), 10_000)
  try { await stopped } finally { clearTimeout(fallback) }
}

try {
  await mkdir(sessionsDirectory, { recursive: true })
  await mkdir(join(root, 'project'), { recursive: true })
  const now = Date.now()
  for (let index = 0; index < sessions; index += 1) {
    const id = randomUUID()
    const at = new Date(now - index * 1_000).toISOString()
    const lines = [JSON.stringify({
      timestamp: at,
      type: 'session_meta',
      payload: { id, timestamp: at, cwd: join(root, 'project'), source: 'cli', originator: 'codex_cli_rs' },
    })]
    for (let record = 0; record < observationsPerSession; record += 1) {
      lines.push(JSON.stringify({
        timestamp: at,
        type: 'event_msg',
        payload: record === 0
          ? { type: 'user_message', message: `首次安装验证 ${index}` }
          : { type: 'agent_message', message: `回复 ${record}`, phase: 'final_answer' },
      }))
    }
    await writeFile(join(sessionsDirectory, `rollout-${id}.jsonl`), `${lines.join('\n')}\n`)
  }
  const port = await reservePort()
  const environment = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: codexHome,
    AGENT_LENS_DB_PATH: join(root, 'agent-lens.db'),
    AGENT_LENS_VAULT_PATH: join(root, 'vault'),
    AGENT_LENS_INTEGRATIONS_DIR: join(root, 'integrations'),
    AGENT_LENS_CAPTURE_POLICY_PATH: join(root, 'config', 'capture-policy.json'),
    AGENT_LENS_INTEGRATION_AUTH_PATH: join(root, 'config', 'authorization.json'),
    AGENT_LENS_INTEGRATION_PREFERENCES_PATH: join(root, 'config', 'preferences.json'),
    AGENT_LENS_PORT: String(port),
    AGENT_LENS_DAEMON_MODE: 'managed',
    AGENT_LENS_PROFILE: 'standalone',
    AGENT_LENS_ENABLED_SOURCES: 'codex',
    AGENT_LENS_DEV_REINSTALL_INTEGRATIONS: '',
  }
  if (onboarding) Reflect.deleteProperty(environment, 'AGENT_LENS_ENABLED_SOURCES')
  const startedAt = performance.now()
  child = spawn(process.execPath, [...(distribution ? [] : ['--import', 'tsx']), '--input-type=module', '-e', `
    process.on('message', message => {
      if (message !== 'benchmark:shutdown') return
      process.emit('SIGTERM')
      process.disconnect()
    })
    await import(${JSON.stringify(distribution ? './dist/daemon.mjs' : './apps/daemon/src/main.ts')})
  `], { cwd: repositoryRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
  child.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(-100_000) })
  child.stderr?.on('data', chunk => { output = (output + String(chunk)).slice(-100_000) })
  let httpReadyMs: number | undefined
  let firstSessionVisibleMs: number | undefined
  let firstDetailReadableMs: number | undefined
  let firstSessionNotificationMs: number | undefined
  let marks: unknown
  const base = `http://127.0.0.1:${port}`
  while (performance.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`隔离 Daemon 提前退出：${output}`)
    try {
      const response = await fetch(`${base}/api/v1/review?limit=20`, { signal: AbortSignal.timeout(2_000) })
      if (!response.ok) throw new Error(`列表返回 ${response.status}`)
      const list = await response.json() as { items: Array<{ id: string }> }
      httpReadyMs ??= performance.now() - startedAt
      if (!onboarding && !eventsTask) {
        eventsTask = (async () => {
          const events = await fetch(`${base}/api/v1/events`, { signal: eventsController.signal })
          if (!events.ok || !events.body) throw new Error('会话通知通道不可用')
          const decoder = new TextDecoder()
          let buffer = ''
          for await (const chunk of events.body) {
            buffer += decoder.decode(chunk, { stream: true })
            const frames = buffer.split(/\r?\n\r?\n/)
            buffer = frames.pop() ?? ''
            for (const frame of frames) {
              const data = frame.split(/\r?\n/).find(line => line.startsWith('data:'))
              if (!data) continue
              const event = JSON.parse(data.slice(5)) as { type?: string }
              if (event.type === 'session.updated') {
                firstSessionNotificationMs ??= performance.now() - startedAt
                return
              }
            }
          }
        })().catch(error => {
          if (!eventsController.signal.aborted) output += `\n会话通知失败：${String(error)}`
        })
      }
      if (list.items.length) firstSessionVisibleMs ??= performance.now() - startedAt
      if (onboarding || (list.items.length && firstSessionNotificationMs !== undefined)) {
        if (!onboarding) {
          const detailResponse = await fetch(`${base}/api/v1/review/${encodeURIComponent(list.items[0]!.id)}?direction=backward&limit=10&process=summary`, { signal: AbortSignal.timeout(5_000) })
          const detail = await detailResponse.json()
          if (!detailResponse.ok || !JSON.stringify(detail).includes('首次安装验证')) {
            throw new Error('首个会话尚无可阅读的用户内容')
          }
          firstDetailReadableMs = performance.now() - startedAt
        }
        const health = await (await fetch(`${base}/api/v1/health`)).json() as { storage?: { details?: { startupSessionPath?: unknown } } }
        marks = health.storage?.details?.startupSessionPath
        break
      }
    } catch { /* 数据库和首批会话尚在启动，继续观察。 */ }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const usableMs = onboarding ? httpReadyMs : firstDetailReadableMs
  if (!marks && httpReadyMs !== undefined) {
    const health = await (await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(2_000) })).json() as { storage?: { details?: { startupSessionPath?: unknown } } }
    marks = health.storage?.details?.startupSessionPath
  }
  console.log(JSON.stringify({
    scenario: onboarding ? '全新安装未选择来源' : '空数据库已选择 Codex 来源',
    runtime: distribution ? '发行构建' : '源码开发运行',
    fixture: { sessions, observationsPerSession },
    httpReadyMs, firstSessionVisibleMs, firstSessionNotificationMs, firstDetailReadableMs,
    budgetMs, passed: usableMs !== undefined && usableMs <= budgetMs,
    startupSessionPath: marks,
  }, null, 2))
  if (usableMs === undefined) throw new Error(`首次可用超时：${output}`)
  if (usableMs > budgetMs) process.exitCode = 1
} finally {
  eventsController.abort()
  await eventsTask
  await stopDaemon()
  await rm(root, { recursive: true, force: true })
}
