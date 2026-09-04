import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_STRING = 32 * 1024
const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie)/i
const DEFAULT_ENABLED_SOURCES = ['claude-code']

function capturePolicyConfigurationPath(env = process.env) {
  return env.AGENT_LENS_CAPTURE_POLICY_PATH
    || join(homedir(), '.agent-lens', '1.0', 'config', 'capture-policy.json')
}

function configuredSources(env = process.env) {
  try {
    const value = JSON.parse(readFileSync(capturePolicyConfigurationPath(env), 'utf8'))
    if (value?.version !== 1 || !Array.isArray(value.enabledSources)
      || value.enabledSources.some(item => typeof item !== 'string')) return null
    return [...new Set(value.enabledSources.map(item => item.trim().toLowerCase()).filter(Boolean))]
  } catch {
    return null
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function truncate(value) {
  return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}…[truncated]`
}

function sanitize(value, depth = 0) {
  if (depth > 8) return '[max-depth]'
  if (typeof value === 'string') return truncate(value)
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitize(item, depth + 1))
  if (typeof value !== 'object') return String(value)

  const result = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitize(item, depth + 1)
  }
  return result
}

export function enabledSources(env = process.env) {
  const raw = String(env.AGENT_LENS_ENABLED_SOURCES || '').trim()
  if (!raw) return configuredSources(env) ?? [...DEFAULT_ENABLED_SOURCES]
  if (raw.toLowerCase() === 'none') return []
  return [...new Set(raw.split(',').map(value => value.trim().toLowerCase()).filter(Boolean))]
}

export function sourceCaptureEnabled(sourceId, env = process.env) {
  return enabledSources(env).includes(String(sourceId || '').trim().toLowerCase())
}

export function codexInboxDirectory(env = process.env) {
  return env.AGENT_LENS_CODEX_INBOX
    || join(homedir(), '.agent-lens', '1.0', 'inbox', 'codex')
}

export function neutralHookOutput(eventName) {
  return eventName === 'Stop' || eventName === 'SubagentStop' ? '{}' : ''
}

export async function persistCodexHookEvent(rawEvent, options = {}) {
  const env = options.env || process.env
  if (!sourceCaptureEnabled('codex', env)) return null

  const event = sanitize(rawEvent)
  const capturedAt = new Date().toISOString()
  const suppliedId = typeof event.source_event_id === 'string' && event.source_event_id
    ? event.source_event_id
    : typeof event.hook_invocation_id === 'string' && event.hook_invocation_id
      ? event.hook_invocation_id
      : randomUUID()
  const id = String(suppliedId)
  const inbox = options.inboxDir || codexInboxDirectory(env)
  const fileKey = sha256(id).slice(0, 24)
  const timestampKey = capturedAt.replace(/[^0-9]/g, '')
  const finalPath = join(inbox, `${timestampKey}-${fileKey}.json`)
  const tempPath = join(inbox, `.${fileKey}-${process.pid}-${randomUUID()}.tmp`)
  const envelope = { id, capturedAt, event }

  await mkdir(inbox, { recursive: true, mode: 0o700 })
  await writeFile(tempPath, JSON.stringify(envelope), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })

  try {
    await rename(tempPath, finalPath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    if (error && typeof error === 'object' && error.code === 'EEXIST') return finalPath
    throw error
  }

  return finalPath
}

export const hookInboxInternals = {
  sanitize,
  configuredSources,
  capturePolicyConfigurationPath,
}
