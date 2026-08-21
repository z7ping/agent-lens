import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  Disposable,
  SourceExecutionContext,
  SourceRecord,
  SourceRecordEmitter,
} from '@agent-lens/core'

const POLL_INTERVAL_MS = 250
const MAX_STRING = 32 * 1024
const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie)/i

interface CodexInboxEnvelope {
  id: string
  capturedAt: string
  event: Record<string, unknown>
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function truncate(value: string): string {
  return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}…[truncated]`
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[max-depth]'
  if (typeof value === 'string') return truncate(value)
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitize(item, depth + 1))
  if (typeof value !== 'object') return String(value)

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitize(item, depth + 1)
  }
  return result
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function inboxDirectory(): string {
  return process.env.AGENT_LENS_CODEX_INBOX
    ?? join(homedir(), '.agent-lens', '1.0', 'inbox', 'codex')
}

function stringField(event: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = event[name]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function eventName(event: Record<string, unknown>): string {
  return stringField(event, 'hook_event_name', 'event_name', 'type') ?? 'UnknownHookEvent'
}

function nativeSessionId(event: Record<string, unknown>): string {
  return stringField(event, 'session_id', 'conversation_id', 'sessionId') ?? 'runtime-unknown'
}

function nativeId(event: Record<string, unknown>): string | undefined {
  const name = eventName(event)
  if (name === 'PreToolUse' || name === 'PostToolUse') {
    return stringField(event, 'call_id', 'tool_use_id')
  }
  return stringField(
    event,
    'source_event_id',
    'hook_invocation_id',
    'turn_id',
    'agent_id',
    'subagent_id',
  )
}

function parseEnvelope(text: string, fileName: string): CodexInboxEnvelope {
  try {
    const parsed = asRecord(JSON.parse(text))
    const event = asRecord(sanitize(parsed.event))
    return {
      id: typeof parsed.id === 'string' && parsed.id ? parsed.id : fileName,
      capturedAt: typeof parsed.capturedAt === 'string' && parsed.capturedAt
        ? parsed.capturedAt
        : new Date().toISOString(),
      event,
    }
  } catch {
    return {
      id: fileName,
      capturedAt: new Date().toISOString(),
      event: {
        hook_event_name: 'MalformedInboxEvent',
        raw: truncate(text),
      },
    }
  }
}

function sourceRecordFromEnvelope(
  envelope: CodexInboxEnvelope,
  filePath: string,
  ctx: SourceExecutionContext,
): SourceRecord {
  const event = envelope.event
  const sessionId = nativeSessionId(event)
  const hookName = eventName(event)
  const stableNativeId = nativeId(event)
  const occurredAt = stringField(event, 'timestamp', 'ts') ?? envelope.capturedAt
  const cwd = stringField(event, 'cwd', 'working_directory', 'workdir')

  return {
    id: `codex-runtime-${sha256(envelope.id).slice(0, 32)}`,
    sourceId: 'codex',
    installationId: ctx.installation.id,
    sourceSessionNativeId: sessionId,
    nativeType: `hook/${hookName}`,
    ...(stableNativeId ? { nativeId: stableNativeId } : {}),
    occurredAt,
    capturedAt: envelope.capturedAt,
    locator: {
      kind: 'runtime-hook',
      path: filePath,
      hookEventId: envelope.id,
    },
    fingerprint: sha256(JSON.stringify(event)),
    payload: {
      runtimeEvent: event,
      session: {
        nativeSessionId: sessionId,
        ...(cwd ? { cwd } : {}),
      },
    },
    parserVersion: '1',
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export async function startCodexRuntimeCapture(
  ctx: SourceExecutionContext,
  emitter: SourceRecordEmitter,
): Promise<Disposable> {
  const inbox = inboxDirectory()
  await mkdir(inbox, { recursive: true })
  let stopped = false

  const task = (async () => {
    while (!stopped && !ctx.abortSignal.aborted) {
      let files: string[] = []
      try {
        files = (await readdir(inbox))
          .filter(name => name.endsWith('.json'))
          .sort((a, b) => a.localeCompare(b))
      } catch {
        files = []
      }

      for (const fileName of files) {
        if (stopped || ctx.abortSignal.aborted) break
        const filePath = join(inbox, fileName)
        try {
          const text = await readFile(filePath, 'utf8')
          const envelope = parseEnvelope(text, fileName)
          const record = sourceRecordFromEnvelope(envelope, filePath, ctx)
          await emitter.emit(record)
          await unlink(filePath)
        } catch {
          // Durable inbox semantics: leave the file in place and retry later.
          break
        }
      }

      if (!stopped && !ctx.abortSignal.aborted) {
        await sleep(POLL_INTERVAL_MS, ctx.abortSignal)
      }
    }
  })()

  return {
    async dispose(): Promise<void> {
      if (stopped) return
      stopped = true
      await task
    },
  }
}

export const codexRuntimeInternals = {
  inboxDirectory,
  parseEnvelope,
  sourceRecordFromEnvelope,
}
