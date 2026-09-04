import { existsSync } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  capturePolicyConfigurationPath,
  readCapturePolicyConfiguration,
  writeCapturePolicyConfiguration,
} from '@agent-lens/capture-policy/configuration'
import { enabledSourcesFromEnv } from '@agent-lens/capture-policy/service'
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
import { resolveHookExecutionProfile } from './hook-execution'
import {
  getLifecycleStatus,
  serviceRestart,
  serviceStart,
  serviceStop,
  setAutostart,
  type LifecycleStatus,
} from './lifecycle'

const VERSION = '1.0.0-alpha.2'
const DEFAULT_PORT = 56789
const MIN_NODE = [22, 23, 0] as const

type CheckLevel = 'pass' | 'warn' | 'fail'
type SourceId = 'codex' | 'claude' | 'pi' | 'hermes' | 'opencode'
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

interface LifecycleProbe {
  status: LifecycleStatus | null
  error: string | null
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
    '  agent-lens capture sources status [--json]',
    '  agent-lens capture sources enable <source...>',
    '  agent-lens capture sources disable <source...>',
    '  agent-lens capture sources set <source...|none>',
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

function lifecycleOptions(requireBuilt = true): { cliEntry: string } {
  const current = fileURLToPath(import.meta.url)
  if (current.endsWith('.mjs')) return { cliEntry: current }
  const built = fileURLToPath(new URL('../../../dist/cli.mjs', import.meta.url))
  if (existsSync(built)) return { cliEntry: built }
  if (!requireBuilt) return { cliEntry: current }
  throw new Error('源码模式使用 service/autostart 前请先执行 npm run build:dist，后台服务只注册正式 dist 入口。')
}

async function lifecycleStatusProbe(): Promise<LifecycleProbe> {
  try {
    return { status: await getLifecycleStatus(lifecycleOptions(false)), error: null }
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function lifecycleDetail(status: LifecycleStatus): string {
  const parts = [
    lifecycleManagerLabel(status),
    status.registered ? '已注册' : '未注册',
    status.active ? '运行中' : '未运行',
    status.autostart ? '登录自启已启用' : '登录自启未启用',
  ]
  if (status.manager === 'windows-task-scheduler' && status.registered) {
    parts.push(status.hidden === true ? '隐藏窗口' : '窗口隐藏未确认')
  }
  if (status.detail) parts.push(status.detail)
  return parts.join(' · ')
}

function firstCandidate(candidates: string[]): string {
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!
}

function sourceRoots(): DetectedSourceRoot[] {
  const home = homedir()
  const hermesRoot = process.env.HERMES_HOME ?? firstCandidate(process.platform === 'win32'
    ? [
        join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'hermes'),
        join(home, '.hermes'),
      ]
    : [join(home, '.hermes')])
  const openCodeRoot = process.env.OPENCODE_HOME ?? firstCandidate(process.platform === 'win32'
    ? [
        join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'opencode'),
        join(home, '.local', 'share', 'opencode'),
      ]
    : [join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'opencode')])
  const roots: ReadonlyArray<readonly [SourceId, string]> = [
    ['codex', process.env.CODEX_HOME ?? join(home, '.codex')],
    ['claude', process.env.CLAUDE_HOME ?? join(home, '.claude')],
    ['pi', process.env.PI_HOME ?? join(home, '.pi')],
    ['hermes', hermesRoot],
    ['opencode', openCodeRoot],
  ]
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
    ? `，信任=${status.trusted === true ? '正常' : status.trusted === false ? '缺失' : '未知'}`
    : ''
  return `${status.target}：${status.installed ? '已安装' : '未安装'}（${status.installedEvents.length} 个事件${trust}）`
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
  const hookProfile = resolveHookExecutionProfile()
  let hooks = await getAllHookStatus(hookProfile.options)
  const hookTargets = setupHookTargets(sources, hooks)
  for (const target of hookTargets) await installHooks(target, hookProfile.options)
  if (hookTargets.length) hooks = await getAllHookStatus(hookProfile.options)

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
    hookExecution: process.platform === 'win32'
      ? { windowsNoWindow: hookProfile.windowsNoWindow, runnerPath: hookProfile.runnerPath ?? null }
      : null,
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
  if (process.platform === 'win32') {
    console.log(`${hookProfile.windowsNoWindow ? '[OK]' : '[WARN]'} Windows Hook：${hookProfile.windowsNoWindow ? '已使用无窗口启动器' : '未找到无窗口启动器，将使用标准命令入口'}`)
  }
  const pi = sources.find(item => item.source === 'pi')
  if (pi?.detected) console.log('[OK] Pi：使用原生历史与运行时采集，无需安装 Hook')
  const openCode = sources.find(item => item.source === 'opencode')
  if (openCode?.detected) console.log('[OK] OpenCode：使用原生数据库历史与运行时采集，无需安装 Hook')
  const hermes = sources.find(item => item.source === 'hermes')
  if (hermes?.detected) console.log('[OK] Hermes：默认使用 state.db；实时 Observer 为显式启用的可选增强')
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
  const hookProfile = resolveHookExecutionProfile()
  let statuses: HookStatus[]
  if (action === 'status') {
    statuses = target === 'all' ? await getAllHookStatus(hookProfile.options) : [await getHookStatus(target, hookProfile.options)]
  } else if (action === 'install') {
    statuses = target === 'all' ? await installAllHooks(hookProfile.options) : [await installHooks(target, hookProfile.options)]
  } else if (action === 'uninstall') {
    statuses = target === 'all' ? await uninstallAllHooks(hookProfile.options) : [await uninstallHooks(target, hookProfile.options)]
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
  console.log(`后台运行：${state.active ? '运行中' : '未运行'}`)
  console.log(`登录自启：${state.autostart ? '已启用' : '未启用'}`)
  if (state.manager === 'windows-task-scheduler' && state.registered) {
    console.log(`后台窗口：${state.hidden === true ? '隐藏' : '隐藏状态未确认'}`)
  }
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
  let health: Record<string, unknown> | null = null
  let healthError: string | null = null
  try {
    health = await fetchHealth()
  } catch (error) {
    healthError = error instanceof Error ? error.message : String(error)
  }
  const lifecycle = await lifecycleStatusProbe()
  const owner = health ? runtimeOwner(health) : null
  const result = {
    online: health !== null,
    url: daemonUrl('/'),
    owner,
    ...(health ? { health } : { error: healthError }),
    lifecycle: lifecycle.status,
    lifecycleError: lifecycle.error,
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return health ? 0 : 1
  }

  if (health) {
    console.log('AgentLens 后台运行时：在线')
    console.log(`Web：${daemonUrl('/')}`)
    console.log(`协议版本：${String(health.protocolVersion ?? 'unknown')}`)
    console.log(`管理方式：${runtimeOwnerLabel(owner)}`)
  } else {
    console.log(`AgentLens 后台运行时：离线（${healthError ?? '无法连接'}）`)
  }
  if (lifecycle.status) printLifecycleState(lifecycle.status)
  else console.log(`系统托管：无法读取（${lifecycle.error ?? '未知错误'}）`)
  return health ? 0 : 1
}

async function doctor(json: boolean): Promise<number> {
  const checks: DoctorCheck[] = []
  const actualNode = parseNodeVersion(process.versions.node)
  checks.push({
    id: 'node',
    level: versionAtLeast(actualNode, MIN_NODE) ? 'pass' : 'fail',
    message: `Node.js ${process.versions.node}`,
    detail: `要求 >= ${MIN_NODE.join('.')}`,
  })

  const root = join(homedir(), '.agent-lens', '1.0')
  try {
    await mkdir(root, { recursive: true })
    await access(root)
    checks.push({ id: 'data-root', level: 'pass', message: 'AgentLens 数据目录可访问', detail: root })
  } catch (error) {
    checks.push({ id: 'data-root', level: 'fail', message: 'AgentLens 数据目录不可访问', detail: String(error) })
  }

  let health: Record<string, unknown> | null = null
  try {
    health = await fetchHealth()
    checks.push({
      id: 'daemon',
      level: 'pass',
      message: '后台运行时可连接',
      detail: `${daemonUrl('/')} · 协议 ${String(health.protocolVersion ?? 'unknown')} · ${runtimeOwnerLabel(runtimeOwner(health))}`,
    })
  } catch (error) {
    checks.push({ id: 'daemon', level: 'warn', message: '后台运行时当前不可连接', detail: error instanceof Error ? error.message : String(error) })
  }

  const lifecycle = await lifecycleStatusProbe()
  if (lifecycle.status) {
    const owner = health ? runtimeOwner(health) : null
    const staleWindowsDefinition = lifecycle.status.manager === 'windows-task-scheduler'
      && lifecycle.status.registered
      && lifecycle.status.hidden !== true
    const ownershipMismatch = (lifecycle.status.active && !health)
      || (owner === 'service' && !lifecycle.status.active)
    checks.push({
      id: 'lifecycle',
      level: staleWindowsDefinition || ownershipMismatch ? 'warn' : 'pass',
      message: staleWindowsDefinition
        ? 'Windows 后台任务仍是旧定义，未确认隐藏控制台窗口'
        : ownershipMismatch
          ? '系统托管状态与当前运行时状态不一致'
          : '系统托管状态可读取',
      detail: `${lifecycleDetail(lifecycle.status)}${staleWindowsDefinition ? ' · 执行 agent-lens service start 可刷新定义' : ''}`,
    })
  } else {
    checks.push({
      id: 'lifecycle',
      level: 'warn',
      message: '系统托管状态无法读取',
      detail: lifecycle.error ?? '未知错误',
    })
  }

  for (const { source, root: sourceRoot, detected } of sourceRoots()) {
    checks.push({
      id: `source-${source}`,
      level: detected ? 'pass' : 'warn',
      message: `${source}：${detected ? '已检测到' : '未检测到'}`,
      detail: sourceRoot,
    })
  }

  const hookProfile = resolveHookExecutionProfile()
  try {
    const hooks = await getAllHookStatus(hookProfile.options)
    for (const item of hooks) {
      checks.push({
        id: `hook-${item.target}`,
        level: item.installed && (item.target !== 'codex' || item.trusted !== false) ? 'pass' : 'warn',
        message: formatHookStatus(item),
        detail: item.configPath,
      })
    }
  } catch (error) {
    checks.push({ id: 'hooks', level: 'warn', message: 'Hook 状态无法读取', detail: error instanceof Error ? error.message : String(error) })
  }

  if (process.platform === 'win32') {
    checks.push({
      id: 'windows-hook-runner',
      level: hookProfile.windowsNoWindow ? 'pass' : 'warn',
      message: hookProfile.windowsNoWindow ? 'Windows Hook 无窗口启动器可用' : 'Windows Hook 无窗口启动器不可用',
      detail: hookProfile.runnerPath ?? '未解析到启动器路径',
    })
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

function validSourceId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.trim())
}

async function runCaptureSources(action: string, values: string[], json: boolean): Promise<number> {
  const path = capturePolicyConfigurationPath(process.env)
  const persisted = await readCapturePolicyConfiguration(path)
  const environmentOverride = process.env.AGENT_LENS_ENABLED_SOURCES !== undefined
  const effective = environmentOverride
    ? enabledSourcesFromEnv(process.env.AGENT_LENS_ENABLED_SOURCES)
    : persisted?.enabledSources ?? enabledSourcesFromEnv(undefined)

  if (action === 'status') {
    const result = {
      enabledSources: effective,
      managedBy: environmentOverride ? 'environment' : persisted ? 'file' : 'default',
      editable: !environmentOverride,
      configurationPath: path,
      updatedAt: persisted?.updatedAt ?? null,
    }
    if (json) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`用户级采集来源：${effective.join(', ') || '(none)'}`)
      console.log(`管理方式：${environmentOverride ? '兼容环境变量（AgentLens 配置只读）' : persisted ? 'AgentLens 用户配置' : '默认隐私策略'}`)
      console.log(`配置文件：${path}`)
    }
    return 0
  }

  if (environmentOverride) {
    throw new Error('当前来源采集由 AGENT_LENS_ENABLED_SOURCES 兼容环境变量覆盖；请先移除该覆盖，再由 AgentLens 管理')
  }
  if (!['enable', 'disable', 'set'].includes(action)) {
    throw new Error(`Unknown capture sources action: ${action}`)
  }
  if (!values.length) throw new Error(`capture sources ${action} 至少需要一个来源 ID，或使用 set none`)
  if (values.some(value => value.toLowerCase() !== 'none' && !validSourceId(value))) {
    throw new Error('来源 ID 只能包含字母、数字、点、下划线和连字符')
  }

  const current = new Set(effective)
  if (action === 'set') current.clear()
  if (!(action === 'set' && values.length === 1 && values[0]?.toLowerCase() === 'none')) {
    for (const raw of values) {
      const sourceId = raw.trim().toLowerCase()
      if (sourceId === 'none') throw new Error('none 只能单独用于 capture sources set none')
      if (action === 'disable') current.delete(sourceId)
      else current.add(sourceId)
    }
  }
  const saved = await writeCapturePolicyConfiguration(path, [...current])
  const result = {
    enabledSources: saved.enabledSources,
    managedBy: 'file',
    editable: true,
    configurationPath: path,
    updatedAt: saved.updatedAt,
    restartRequired: true,
  }
  if (json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`AgentLens 用户级采集来源已保存：${saved.enabledSources.join(', ') || '(none)'}`)
    console.log('Hook 从下一次调用起读取新设置；AgentLens 运行时需要重启后完全应用来源启停。')
  }
  return 0
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
  if (command === 'capture' && args[1] === 'sources') return runCaptureSources(args[2] ?? 'status', args.slice(3), json)
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
  lifecycleDetail,
}
