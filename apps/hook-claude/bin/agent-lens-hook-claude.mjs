#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_STRING = 32 * 1024
const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie)/i
const DEFAULT_ENABLED_SOURCES = ['claude-code']

function sourceCaptureEnabled(sourceId, env = process.env) {
  const raw = String(env.AGENT_LENS_ENABLED_SOURCES || '').trim()
  const normalizedSourceId = String(sourceId || '').trim().toLowerCase()
  if (!raw) return DEFAULT_ENABLED_SOURCES.includes(normalizedSourceId)
  if (raw.toLowerCase() === 'none') return false
  return raw.split(',').some(value => value.trim().toLowerCase() === normalizedSourceId)
}

function sanitize(value, depth = 0) {
  if (depth > 8) return '[max-depth]'
  if (typeof value === 'string') return value.length <= MAX_STRING
    ? value
    : `${value.slice(0, MAX_STRING)}…[truncated]`
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitize(item, depth + 1))
  if (typeof value !== 'object') return String(value)
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitize(item, depth + 1)
  }
  return result
}

function inboxDirectory() {
  return process.env.AGENT_LENS_CLAUDE_INBOX
    || join(homedir(), '.agent-lens', '1.0', 'inbox', 'claude-code')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

let raw = ''
for await (const chunk of process.stdin) raw += chunk
if (!raw.trim() || !sourceCaptureEnabled('claude-code')) process.exit(0)

try {
  const parsed = sanitize(JSON.parse(raw))
  const capturedAt = new Date().toISOString()
  const suppliedId = typeof parsed.source_event_id === 'string' && parsed.source_event_id
    ? parsed.source_event_id
    : typeof parsed.hook_invocation_id === 'string' && parsed.hook_invocation_id
      ? parsed.hook_invocation_id
      : randomUUID()
  const id = String(suppliedId)
  const inbox = inboxDirectory()
  const fileKey = sha256(id).slice(0, 24)
  const timestampKey = capturedAt.replace(/[^0-9]/g, '')
  const finalPath = join(inbox, `${timestampKey}-${fileKey}.json`)
  const tempPath = join(inbox, `.${fileKey}-${process.pid}-${randomUUID()}.tmp`)
  await mkdir(inbox, { recursive: true, mode: 0o700 })
  await writeFile(tempPath, JSON.stringify({ id, capturedAt, event: parsed }), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  try {
    await rename(tempPath, finalPath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    if (!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error
  }
} catch {
  // Passive hook: never block Claude Code because AgentLens capture failed.
}
