import { existsSync } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import {
  getAllHookStatus,
  getHookStatus,
  installAllHooks,
  installHooks,
  uninstallAllHooks,
  uninstallHooks,
  type HookStatus,
  type HookTarget,
} from '@agent-lens/hook-manager'
import {
  getLifecycleStatus,
  serviceRestart,
  serviceStart,
  serviceStop,
  setAutostart,
  type LifecycleStatus,
} from './lifecycle'

const VERSION = '1.0.0-alpha.0'
const DEFAULT_PORT = 56789
const MIN_NODE = [22, 23, 0] as const

type CheckLevel = 'pass' | 'warn' | 'fail'
type SourceId = 'codex' | 'claude' | 'pi'
type RuntimeOwner = 'cli' | 'service'
type RuntimeMode = 'foreground' | 'managed'

export interface DoctorCheck {
  id: string
  level: CheckLevel
  message: string
  detail?: string
}

interface DetectedSourceRoot {
  source: SourceId
  root: string
  detected: boolean
}

function usage(): string {
  return [
    'AgentLens 1.0',
    '',
    '用法：',
    '  agent-lens setup [--json]',
    '  agent-lens start',
    '  agent-lens status [--json]',
    '  agent-lens doctor [--json]',
    '  agent-lens service start|stop|restart|status [--json]',
    '  agent-lens autostart enable|disable|status [--json]',
    '  agent-lens hook status [codex|claude|all] [--json]',
    '  agent-lens hook install [codex|claude|all]',
    '  agent-lens hook uninstall [codex|claude|all]',
    '  agent-lens --version',
  ].join('\n')
}

function parseNodeVersion(value: string): [number, number, number] {
  const parts = value.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10))
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

function versionAtLeast(actual: readonly number[], expected: readonly number[]): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if ((actual[index] ?? 0) > (expected[index] ?? 0)) return true
    if ((actual[index] ?? 0) < (expected[index] ?? 0)) return false
  }
  return true
}

function daemonUrl(pathname = '/api/v1/health'): string {
  const port = process.env.AGENT_LENS_PORT ? Number(process.env.AGENT_LENS_PORT) : DEFAULT_PORT
  return `http://127.0.0.1:${port}${pathname}`
}

async function fetchHealth(): Promise<Record<string, unknown>> {
  const response = await fetch(daemonUrl(), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(1500),
  })
  if (!response.ok && response.status !== 503) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<Record<string, unknown>>
}

async function healthOrNull(): Promise<Record<string, unknown> | null> {
  try {
    return await fetchHealth()
  } catch {
    return null
  }
}

async function waitForHealth(timeoutMs = 4000): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs
  do {
    const health = await healthOrNull()
    if (health) return health
    await delay(200)
  } while (Date.now() < deadline)
  return null
}

function runtimeOwner(health: Record<string, unknown>): string | null {
  const runtime = health.runtime
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return null
  const owner = (runtime as Record<string, unknown>).owner
  return typeof owner === 'string' && owner ? owner : null
}

function runtimeOwnerLabel(owner: string | null): string {
  if (owner === 'desktop') return 'Windows 客户端'
  if (owner === 'service') return '后台服务'
  if (owner === 'cli') return '命令行'
  return owner ?? '未报告'
}

function lifecycleManagerLabel(status: LifecycleStatus): string {
  if (status.manager === 'windows-task-scheduler') return 'Windows 用户级计划任务'
  if (status.manager === 'systemd-user') return 'systemd 用户服务'
  return 'launchd 用户服务'
}

function lifecycleOptions(): { cliEntry: string } {
  const current = fileURLToPath(import.meta.url)
  if (current.endsWith('.mjs')) return { cliEntry: current }
  const built = fileURLToPath(new URL('../../../dist/cli.mjs', import.meta.url))
  if (!existsSync(built)) {
    throw new Error('源码模式使用 service/autostart 前请先执行 npm run build:dist，后台服务只注册正式 dist 入口。')
  }
  return { cliEntry: built }
}

function sourceRoots(): DetectedSourceRoot[] {
  const roots = [
    ['codex', process.env.CODEX_HOME ?? join(homedir(), '.codex')],
    ['claude', process.env.CLAUDE_HOME ?? join(homedir(), '.claude')],
    ['pi', process.env.PI_HOME ?? join(homedir(), '.pi')],
  ] as const
  return roots.map(([source, root]) => ({ source, root, detected: existsSync(root) }))
}

function setupHookTargets(
  sources: readonly Pick<DetectedSourceRoot, 'source' | 'detected'>[],
  statuses: readonly Pick<HookStatus, 'target' | 'installed' | 'trusted'>[],
): HookTarget[] {
  const detected = new Set(sources.filter(item => item.detected).map(item => item.source))
  const byTarget = new Map(statuses.map(item => [item.target, item]))
  const result: HookTarget[] = []
  for (const target of ['codex', 'claude'] as const) {
    if (!detected.has(target)) continue
    const status = byTarget.get(target)
    if (!status || !status.installed || (target === 'codex' && status.trusted === false)) result.push(target)
  }
  return result
}

function formatHookStatus(status: HookStatus): string {
  const trust = status.target === 'codex'
    ? `, trust=${status.trusted === true ? 'ok' : status.trusted === false ? 'missing' : 'unknown'}`
    : ''
  return `${status.target}: ${status.installed ? 'installed' : 'not installed'} (${status.installedEvents.length} events${trust})`
}

function targetFrom(value: string | undefined): HookTarget | 'all' {
  if (!value || value === 'all') return 'all'
  if (value === 'codex' || value === 'claude') return value
  throw new Error(`Unknown hook target: ${value}`)
}

async function setup(json: boolean): Promise<number> {
  const actualNode = parseNodeVersion(process.versions.node)
  if (!versionAtLeast(actualNode, MIN_NODE)) {
    const result = {
      ok: false,
      version: VERSION,
      error: `Node.js 版本过低：当前 ${process.versions.node}，要求 >= ${MIN_NODE.join('.')}`,
    }
    if (json) console.log(JSON.stringify(result, null, 2))
    else console.log(result.error)
    return 1
  }

  const root = join(homedir(), '.agent-lens', '1.0')
  await mkdir(root, { recursive: true })
  await access(root)

  const sources = sourceRoots()
  let hooks = await getAllHookStatus()
  const hookTargets = setupHookTargets(sources, hooks)
  for (const target of hookTargets) await installHooks(target)
  if (hookTargets.length) hooks = await getAllHookStatus()

  const health = await healthOrNull()
  const result = {
    ok: true,
    version: VERSION,
    dataRoot: root,
    sources,
    hooks: hooks.map(item => ({
      target: item.target,
      installed: item.installed,
      ...(item.target === 'codex' ? { trusted: item.trusted } : {}),
      changed: hookTargets.includes(item.target),
    })),
    runtime: health
      ? { online: true, url: daemonUrl('/'), owner: runtimeOwner(health), protocolVersion: health.protocolVersion ?? null }
      : { online: false, url: daemonUrl('/') },
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return 0
  }

  console.log('AgentLens 初始化完成。')
  console.log(`[OK] 数据目录：${root}`)
  for (const source of sources) {
    console.log(`${source.detected ? '[OK]' : '[跳过]'} ${source.source}：${source.detected ? '已检测到' : '未检测到'}（${source.root}）`)
  }
  for (const item of hooks) {
    const source = sources.find(sourceItem => sourceItem.source === item.target)
    if (!source?.detected) continue
    const changed = hookTargets.includes(item.target) ? '，本次已补齐' : ''
    const trust = item.target === 'codex' && item.trusted === false ? '，信任配置缺失' : ''
    console.log(`${item.installed && item.trusted !== false ? '[OK]' : '[WARN]'} ${item.target} Hook：${item.installed ? '已安装' : '未安装'}${changed}${trust}`)
  }
  const pi = sources.find(item => item.source === 'pi')
  if (pi?.detected) console.log('[OK] pi：使用原生历史与运行时采集，无需安装 Hook')
  if (health) {
    console.log(`[OK] 运行时：已在线（管理方式：${runtimeOwnerLabel(runtimeOwner(health))}）`)
    console.log(`Web：${daemonUrl('/')}`)
  } else {
    console.log('[提示] 运行时当前未启动。需要长期常驻时可执行 agent-lens service start。')
  }
  console.log('[提示] 需要登录系统后自动运行时可执行 agent-lens autostart enable。')
  return 0
}

async function runHook(action: string, targetValue: string | undefined, json: boolean): Promise<number> {
  const target = targetFrom(targetValue)
  let statuses: HookStatus[]
  if (action === 'status') {
    statuses = target === 'all' ? await getAllHookStatus() : [await getHookStatus(target)]
  } else if (action === 'install') {
    statuses = target === 'all' ? await installAllHooks() : [await installHooks(target)]
  } else if (action === 'uninstall') {
    statuses = target === 'all' ? await uninstallAllHooks() : [await uninstallHooks(target)]
  } else {
    throw new Error(`Unknown hook action: ${action}`)
  }

  if (json) console.log(JSON.stringify(statuses, null, 2))
  else statuses.forEach(status => console.log(formatHookStatus(status)))
  return action === 'status' && statuses.some(status => !status.installed) ? 1 : 0
}

async function startDaemon(owner: RuntimeOwner = 'cli', mode: RuntimeMode = 'foreground'): Promise<number> {
  try {
    const health = await fetchHealth()
    console.log(`AgentLens 已在运行（管理方式：${runtimeOwnerLabel(runtimeOwner(health))}）`)
    console.log(`Web: ${daemonUrl('/')}`)
    return 0
  } catch {
    // No compatible AgentLens health endpoint is currently reachable; start one daemon only.
  }

  const explicit = process.env.AGENT_LENS_DAEMON_ENTRY
  const bundled = fileURLToPath(new URL('./daemon.mjs', import.meta.url))
  const dev = fileURLToPath(new URL('../../daemon/src/main.ts', import.meta.url))
  let commandArgs: string[]

  if (explicit) commandArgs = [explicit]
  else if (existsSync(bundled)) commandArgs = [bundled]
  else commandArgs = ['--import', 'tsx', dev]

  const child = spawn(process.execPath, commandArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENT_LENS_DAEMON_MODE: mode,
      AGENT_LENS_RUNTIME_OWNER: owner,
    },
  })

  const forwarded = new Map<NodeJS.Signals, () => void>()
  if (mode === 'managed') {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const handler = () => {
        if (!child.killed) child.kill(signal)
      }
      forwarded.set(signal, handler)
      process.once(signal, handler)
    }
  }

  return new Promise<number>((resolve, reject) => {
    const cleanup = () => {
      for (const [signal, handler] of forwarded) process.off(signal, handler)
    }
    child.once('error', error => {
      cleanup()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      cleanup()
      if (signal) resolve(1)
      else resolve(code ?? 0)
    })
  })
}

function printLifecycleState(state: LifecycleStatus): void {
  console.log(`系统托管：${lifecycleManagerLabel(state)}`)
  console.log(`服务定义：${state.registered ? '已注册' : '未注册'}`)
  console.log(`后台任务：${state.active ? '运行中' : '未运行'}`)
  console.log(`登录自启：${state.autostart ? '已启用' : '未启用'}`)
  if (state.detail) console.log(`系统状态：${state.detail}`)
}

async function runService(action: string, json: boolean): Promise<number> {
  if (action === 'run') return startDaemon('service', 'managed')
  if (!['start', 'stop', 'restart', 'status'].includes(action)) {
    throw new Error(`Unknown service action: ${action}`)
  }

  const options = lifecycleOptions()
  const before = await healthOrNull()
  if (action === 'restart' && before && runtimeOwner(before) !== 'service') {
    const result = {
      ok: false,
      reason: 'runtime-owned-elsewhere',
      owner: runtimeOwner(before),
      message: `当前运行时由${runtimeOwnerLabel(runtimeOwner(before))}管理，后台服务不会强行接管。`,
    }
    if (json) console.log(JSON.stringify(result, null, 2))
    else console.log(result.message)
    return 1
  }

  let lifecycle: LifecycleStatus
  if (action === 'start') lifecycle = await serviceStart(options)
  else if (action === 'stop') lifecycle = await serviceStop(options)
  else if (action === 'restart') lifecycle = await serviceRestart(options)
  else lifecycle = await getLifecycleStatus(options)

  let health = await healthOrNull()
  if ((action === 'start' || action === 'restart') && !health) health = await waitForHealth()
  if (action === 'stop' && health && runtimeOwner(health) === 'service') {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await delay(150)
      health = await healthOrNull()
      if (!health || runtimeOwner(health) !== 'service') break
    }
  }

  const result = {
    ok: true,
    action,
    lifecycle,
    runtime: health
      ? { online: true, owner: runtimeOwner(health), url: daemonUrl('/') }
      : { online: false, url: daemonUrl('/') },
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return 0
  }

  if (action === 'start') console.log('AgentLens 后台服务启动请求已完成。')
  else if (action === 'stop') console.log('AgentLens 后台服务停止请求已完成。')
  else if (action === 'restart') console.log('AgentLens 后台服务重启请求已完成。')
  printLifecycleState(lifecycle)
  if (health) {
    console.log(`运行时：在线（管理方式：${runtimeOwnerLabel(runtimeOwner(health))}）`)
    console.log(`Web：${daemonUrl('/')}`)
  } else {
    console.log('运行时：当前离线')
  }
  return 0
}

async function runAutostart(action: string, json: boolean): Promise<number> {
  if (!['enable', 'disable', 'status'].includes(action)) {
    throw new Error(`Unknown autostart action: ${action}`)
  }
  const options = lifecycleOptions()
  const lifecycle = action === 'enable'
    ? await setAutostart(true, options)
    : action === 'disable'
      ? await setAutostart(false, options)
      : await getLifecycleStatus(options)

  const result = { ok: true, action, lifecycle }
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return 0
  }
  if (action === 'enable') console.log('AgentLens 登录后自动运行已启用。')
  else if (action === 'disable') console.log('AgentLens 登录后自动运行已关闭。')
  printLifecycleState(lifecycle)
  return 0
}

async function status(json: boolean): Promise<number> {
  try {
    const health = await fetchHealth()
    const owner = runtimeOwner(health)
    if (json) console.log(JSON.stringify({ online: true, url: daemonUrl('/'), owner, health }, null, 2))
    else {
      console.log('AgentLens 后台运行时：在线')
      console.log(`Web: ${daemonUrl('/')}`)
      console.log(`协议版本: ${String(health.protocolVersion ?? 'unknown')}`)
      console.log(`管理方式: ${runtimeOwnerLabel(owner)}`)
    }
    return 0
  } catch (error) {
    const result = { online: false, url: daemonUrl('/'), error: error instanceof Error ? error.message : String(error) }
    if (json) console.log(JSON.stringify(result, null, 2))
    else console.log(`AgentLens 后台运行时：离线（${result.error}）`)
    return 1
  }
}

async function doctor(json: boolean): Promise<number> {
  const checks: DoctorCheck[] = []
  const actualNode = parseNodeVersion(process.versions.node)
  checks.push({
    id: 'node',
    level: versionAtLeast(actualNode, MIN_NODE) ? 'pass' : 'fail',
    message: `Node ${process.versions.node}`,
    detail: `requires >= ${MIN_NODE.join('.')}`,
  })

  const root = join(homedir(), '.agent-lens', '1.0')
  try {
    await mkdir(root, { recursive: true })
    await access(root)
    checks.push({ id: 'data-root', level: 'pass', message: 'AgentLens data directory is accessible', detail: root })
  } catch (error) {
    checks.push({ id: 'data-root', level: 'fail', message: 'AgentLens data directory is not accessible', detail: String(error) })
  }

  try {
    const health = await fetchHealth()
    checks.push({ id: 'daemon', level: 'pass', message: 'Daemon is reachable', detail: `${daemonUrl('/')} · protocol ${String(health.protocolVersion ?? 'unknown')} · owner ${runtimeOwnerLabel(runtimeOwner(health))}` })
  } catch (error) {
    checks.push({ id: 'daemon', level: 'warn', message: 'Daemon is not currently reachable', detail: error instanceof Error ? error.message : String(error) })
  }

  for (const { source, root: sourceRoot, detected } of sourceRoots()) {
    checks.push({
      id: `source-${source}`,
      level: detected ? 'pass' : 'warn',
      message: `${source} source ${detected ? 'detected' : 'not detected'}`,
      detail: sourceRoot,
    })
  }

  try {
    const hooks = await getAllHookStatus()
    for (const item of hooks) {
      checks.push({
        id: `hook-${item.target}`,
        level: item.installed && (item.target !== 'codex' || item.trusted !== false) ? 'pass' : 'warn',
        message: formatHookStatus(item),
        detail: item.configPath,
      })
    }
  } catch (error) {
    checks.push({ id: 'hooks', level: 'warn', message: 'Hook status could not be read', detail: error instanceof Error ? error.message : String(error) })
  }

  const result = {
    version: VERSION,
    ok: !checks.some(item => item.level === 'fail'),
    checks,
  }
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    for (const item of checks) {
      const mark = item.level === 'pass' ? '[OK]' : item.level === 'warn' ? '[WARN]' : '[FAIL]'
      console.log(`${mark} ${item.message}${item.detail ? ` — ${item.detail}` : ''}`)
    }
  }
  return result.ok ? 0 : 1
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const json = argv.includes('--json')
  const args = argv.filter(arg => arg !== '--json')
  const command = args[0]
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(usage())
    return 0
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(VERSION)
    return 0
  }
  if (command === 'setup') return setup(json)
  if (command === 'start') return startDaemon()
  if (command === 'status') return status(json)
  if (command === 'doctor') return doctor(json)
  if (command === 'service') return runService(args[1] ?? 'status', json)
  if (command === 'autostart') return runAutostart(args[1] ?? 'status', json)
  if (command === 'hook') return runHook(args[1] ?? 'status', args[2], json)
  throw new Error(`Unknown command: ${command}\n\n${usage()}`)
}

if (process.argv[1] && dirname(fileURLToPath(import.meta.url)) === dirname(process.argv[1])) {
  main().then(code => { process.exitCode = code }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export const cliInternals = {
  parseNodeVersion,
  versionAtLeast,
  targetFrom,
  daemonUrl,
  runtimeOwner,
  sourceRoots,
  setupHookTargets,
  lifecycleOptions,
}
