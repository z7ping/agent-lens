import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type HookTarget = 'codex' | 'claude'

export interface HookManagerOptions {
  homeDir?: string
  codexHooksFile?: string
  codexConfigFile?: string
  claudeSettingsFile?: string
  codexCommand?: string
  claudeCommand?: string
}

export interface HookStatus {
  target: HookTarget
  configPath: string
  installed: boolean
  installedEvents: string[]
  missingEvents: string[]
  trusted?: boolean
}

interface HookHandler {
  command?: string
  type?: string
  timeout?: number
  [key: string]: unknown
}

interface HookGroup {
  matcher?: unknown
  hooks?: HookHandler[]
  [key: string]: unknown
}

interface HookConfig {
  hooks?: Record<string, HookGroup[]>
  [key: string]: unknown
}

interface HookCoordinate {
  eventName: string
  groupIndex: number
  hookIndex: number
  group: HookGroup
  handler: HookHandler
}

const CLAUDE_EVENTS = ['PreToolUse', 'PostToolUse'] as const
const CODEX_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PermissionRequest',
  'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact',
  'SubagentStart', 'SubagentStop', 'Stop',
] as const

const CODEX_EVENT_LABELS: Record<string, string> = {
  SessionStart: 'session_start', SessionEnd: 'session_end', UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use', PermissionRequest: 'permission_request', PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact', PostCompact: 'post_compact', SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop', Stop: 'stop',
}

function paths(options: HookManagerOptions) {
  const home = options.homeDir ?? homedir()
  return {
    codexHooks: options.codexHooksFile ?? join(home, '.codex', 'hooks.json'),
    codexConfig: options.codexConfigFile ?? join(home, '.codex', 'config.toml'),
    claudeSettings: options.claudeSettingsFile ?? join(home, '.claude', 'settings.json'),
  }
}

function commandFor(target: HookTarget, options: HookManagerOptions): string {
  return target === 'codex'
    ? options.codexCommand ?? 'agent-lens-hook-codex'
    : options.claudeCommand ?? 'agent-lens-hook-claude'
}

function markerFor(target: HookTarget): string {
  return target === 'codex' ? 'agent-lens-hook-codex' : 'agent-lens-hook-claude'
}

async function readJson(path: string): Promise<HookConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be an object')
    return parsed as HookConfig
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') return {}
    throw new Error(`Cannot read hook config ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT') return null
    throw error
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${randomUUID()}.agent-lens.tmp`)
  await writeFile(temp, content, 'utf8')
  try { await rename(temp, path) }
  catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error }
}

function ensureHooks(config: HookConfig): Record<string, HookGroup[]> {
  if (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks)) config.hooks = {}
  return config.hooks
}

function isAgentLensHandler(handler: HookHandler, target: HookTarget): boolean {
  return typeof handler.command === 'string' && handler.command.includes(markerFor(target))
}

function stripAgentLensHandlers(config: HookConfig, target: HookTarget): HookCoordinate[] {
  const root = ensureHooks(config)
  const removed: HookCoordinate[] = []
  for (const [eventName, groups] of Object.entries(root)) {
    if (!Array.isArray(groups)) continue
    const nextGroups: HookGroup[] = []
    groups.forEach((group, groupIndex) => {
      if (!group || !Array.isArray(group.hooks)) { nextGroups.push(group); return }
      const kept: HookHandler[] = []
      group.hooks.forEach((handler, hookIndex) => {
        if (handler && isAgentLensHandler(handler, target)) removed.push({ eventName, groupIndex, hookIndex, group, handler })
        else kept.push(handler)
      })
      if (kept.length) nextGroups.push({ ...group, hooks: kept })
    })
    if (nextGroups.length) root[eventName] = nextGroups
    else delete root[eventName]
  }
  if (!Object.keys(root).length) delete config.hooks
  return removed
}

function addHandler(config: HookConfig, eventName: string, command: string, timeout: number): void {
  const root = ensureHooks(config)
  const groups = root[eventName] ?? []
  groups.push({ hooks: [{ type: 'command', command, timeout, statusMessage: '', async: false }] })
  root[eventName] = groups
}

function coordinates(config: HookConfig, target: HookTarget): HookCoordinate[] {
  const result: HookCoordinate[] = []
  const root = config.hooks ?? {}
  for (const [eventName, groups] of Object.entries(root)) {
    if (!Array.isArray(groups)) continue
    groups.forEach((group, groupIndex) => {
      if (!group || !Array.isArray(group.hooks)) return
      group.hooks.forEach((handler, hookIndex) => {
        if (handler && isAgentLensHandler(handler, target)) result.push({ eventName, groupIndex, hookIndex, group, handler })
      })
    })
  }
  return result
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalJson)
  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = canonicalJson((value as Record<string, unknown>)[key])
    return acc
  }, {})
}

function trustKey(hooksFile: string, coordinate: HookCoordinate): string {
  const eventKey = CODEX_EVENT_LABELS[coordinate.eventName] ?? coordinate.eventName.toLowerCase()
  return `${hooksFile.replace(/\\/g, '/')}:${eventKey}:${coordinate.groupIndex}:${coordinate.hookIndex}`
}

function trustHash(coordinate: HookCoordinate): string {
  const identity: Record<string, unknown> = {
    event_name: CODEX_EVENT_LABELS[coordinate.eventName] ?? coordinate.eventName.toLowerCase(),
    hooks: [coordinate.handler],
  }
  if (coordinate.group.matcher) identity.matcher = coordinate.group.matcher
  const serialized = JSON.stringify(canonicalJson(identity))
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`
}

function tomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function trustHeader(key: string): string {
  return `[hooks.state."${tomlString(key)}"]`
}

function rewriteTrustState(content: string, removeKeys: string[], add: HookCoordinate[], hooksFile: string): string {
  const removeHeaders = new Set(removeKeys.map(trustHeader))
  const lines = content.split(/\r?\n/)
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\[.+\]$/.test(trimmed)) {
      skipping = removeHeaders.has(trimmed)
      if (skipping) continue
    }
    if (!skipping) kept.push(line)
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop()
  for (const coordinate of add) {
    kept.push('', trustHeader(trustKey(hooksFile, coordinate)), `trusted_hash = "${trustHash(coordinate)}"`)
  }
  return `${kept.join('\n')}\n`
}

async function updateCodexTrust(
  configPath: string,
  hooksFile: string,
  removed: HookCoordinate[],
  added: HookCoordinate[],
): Promise<void> {
  const content = await readOptionalText(configPath)
  if (content === null) return
  const keys = [...removed, ...added].map(item => trustKey(hooksFile, item))
  await atomicWrite(configPath, rewriteTrustState(content, keys, added, hooksFile))
}

async function targetStatus(target: HookTarget, options: HookManagerOptions): Promise<HookStatus> {
  const resolved = paths(options)
  const configPath = target === 'codex' ? resolved.codexHooks : resolved.claudeSettings
  const expected = target === 'codex' ? [...CODEX_EVENTS] : [...CLAUDE_EVENTS]
  const config = await readJson(configPath)
  const installedSet = new Set(coordinates(config, target).map(item => item.eventName))
  const installedEvents = expected.filter(item => installedSet.has(item))
  const missingEvents = expected.filter(item => !installedSet.has(item))
  const status: HookStatus = { target, configPath, installed: missingEvents.length === 0, installedEvents, missingEvents }
  if (target === 'codex') {
    const toml = await readOptionalText(resolved.codexConfig)
    if (toml !== null) {
      const current = coordinates(config, 'codex')
      status.trusted = current.length > 0 && current.every(item => toml.includes(trustHeader(trustKey(resolved.codexHooks, item))) && toml.includes(`trusted_hash = "${trustHash(item)}"`))
    }
  }
  return status
}

export function getHookStatus(target: HookTarget, options: HookManagerOptions = {}): Promise<HookStatus> {
  return targetStatus(target, options)
}

export async function installHooks(target: HookTarget, options: HookManagerOptions = {}): Promise<HookStatus> {
  const resolved = paths(options)
  const configPath = target === 'codex' ? resolved.codexHooks : resolved.claudeSettings
  const config = await readJson(configPath)
  const removed = stripAgentLensHandlers(config, target)
  const command = commandFor(target, options)
  const events = target === 'codex' ? CODEX_EVENTS : CLAUDE_EVENTS
  for (const event of events) {
    const timeout = event === 'PostToolUse' ? 10 : event === 'SessionEnd' ? 3 : 5
    addHandler(config, event, command, timeout)
  }
  await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`)
  if (target === 'codex') await updateCodexTrust(resolved.codexConfig, resolved.codexHooks, removed, coordinates(config, 'codex'))
  return targetStatus(target, options)
}

export async function uninstallHooks(target: HookTarget, options: HookManagerOptions = {}): Promise<HookStatus> {
  const resolved = paths(options)
  const configPath = target === 'codex' ? resolved.codexHooks : resolved.claudeSettings
  const config = await readJson(configPath)
  const removed = stripAgentLensHandlers(config, target)
  if (removed.length) await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`)
  if (target === 'codex' && removed.length) await updateCodexTrust(resolved.codexConfig, resolved.codexHooks, removed, [])
  return targetStatus(target, options)
}

export async function getAllHookStatus(options: HookManagerOptions = {}): Promise<HookStatus[]> {
  return Promise.all([getHookStatus('codex', options), getHookStatus('claude', options)])
}

export async function installAllHooks(options: HookManagerOptions = {}): Promise<HookStatus[]> {
  return [await installHooks('codex', options), await installHooks('claude', options)]
}

export async function uninstallAllHooks(options: HookManagerOptions = {}): Promise<HookStatus[]> {
  return [await uninstallHooks('codex', options), await uninstallHooks('claude', options)]
}

export const hookManagerInternals = {
  CODEX_EVENTS,
  CLAUDE_EVENTS,
  stripAgentLensHandlers,
  coordinates,
  rewriteTrustState,
  trustHash,
  trustKey,
}
