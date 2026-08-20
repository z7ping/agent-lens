import { existsSync } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
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

const VERSION = '1.0.0-alpha.0'
const DEFAULT_PORT = 56789
const MIN_NODE = [22, 12, 0] as const

type CheckLevel = 'pass' | 'warn' | 'fail'

export interface DoctorCheck {
  id: string
  level: CheckLevel
  message: string
  detail?: string
}

function usage(): string {
  return [
    'AgentLens 1.0',
    '',
    'Usage:',
    '  agent-lens start',
    '  agent-lens status [--json]',
    '  agent-lens doctor [--json]',
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
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<Record<string, unknown>>
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

async function startDaemon(): Promise<number> {
  const explicit = process.env.AGENT_LENS_DAEMON_ENTRY
  const bundled = fileURLToPath(new URL('./daemon.mjs', import.meta.url))
  const dev = fileURLToPath(new URL('../../daemon/src/main.ts', import.meta.url))
  let commandArgs: string[]

  if (explicit) commandArgs = [explicit]
  else if (existsSync(bundled)) commandArgs = [bundled]
  else commandArgs = ['--import', 'tsx', dev]

  const child = spawn(process.execPath, commandArgs, {
    stdio: 'inherit',
    env: process.env,
  })
  return new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) resolve(1)
      else resolve(code ?? 0)
    })
  })
}

async function status(json: boolean): Promise<number> {
  try {
    const health = await fetchHealth()
    if (json) console.log(JSON.stringify({ online: true, url: daemonUrl('/'), health }, null, 2))
    else {
      console.log(`AgentLens daemon: online`)
      console.log(`Web: ${daemonUrl('/')}`)
      console.log(`Protocol: ${String(health.protocolVersion ?? 'unknown')}`)
    }
    return 0
  } catch (error) {
    const result = { online: false, url: daemonUrl('/'), error: error instanceof Error ? error.message : String(error) }
    if (json) console.log(JSON.stringify(result, null, 2))
    else console.log(`AgentLens daemon: offline (${result.error})`)
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

  const dataRoot = join(homedir(), '.agent-lens', '1.0')
  try {
    await mkdir(dataRoot, { recursive: true })
    await access(dataRoot)
    checks.push({ id: 'data-root', level: 'pass', message: 'AgentLens data directory is accessible', detail: dataRoot })
  } catch (error) {
    checks.push({ id: 'data-root', level: 'fail', message: 'AgentLens data directory is not accessible', detail: String(error) })
  }

  try {
    const health = await fetchHealth()
    checks.push({ id: 'daemon', level: 'pass', message: 'Daemon is reachable', detail: `${daemonUrl('/')} · protocol ${String(health.protocolVersion ?? 'unknown')}` })
  } catch (error) {
    checks.push({ id: 'daemon', level: 'warn', message: 'Daemon is not currently reachable', detail: error instanceof Error ? error.message : String(error) })
  }

  const sourceRoots = [
    ['codex', process.env.CODEX_HOME ?? join(homedir(), '.codex')],
    ['claude', process.env.CLAUDE_HOME ?? join(homedir(), '.claude')],
    ['pi', process.env.PI_HOME ?? join(homedir(), '.pi')],
  ] as const
  for (const [source, root] of sourceRoots) {
    checks.push({
      id: `source-${source}`,
      level: existsSync(root) ? 'pass' : 'warn',
      message: `${source} source ${existsSync(root) ? 'detected' : 'not detected'}`,
      detail: root,
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
  if (command === 'start') return startDaemon()
  if (command === 'status') return status(json)
  if (command === 'doctor') return doctor(json)
  if (command === 'hook') return runHook(args[1] ?? 'status', args[2], json)
  throw new Error(`Unknown command: ${command}\n\n${usage()}`)
}

if (process.argv[1] && dirname(fileURLToPath(import.meta.url)) === dirname(process.argv[1])) {
  main().then(code => { process.exitCode = code }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export const cliInternals = { parseNodeVersion, versionAtLeast, targetFrom, daemonUrl }
