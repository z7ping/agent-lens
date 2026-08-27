import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import type {
  DetectedSource,
  Disposable,
  EvidenceCandidate,
  NormalizedSourceOutput,
  ObservationCapability,
  ObservationCandidate,
  ObservationIdentityHints,
  SourceDefinition,
  SourceDetectionContext,
  SourceExecutionContext,
  SourceNormalizationContext,
  SourcePluginManifest,
  SourceRecord,
  SourceRecordEmitter,
} from '@agent-lens/core'
import {
  defineAgentLensPlugin,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'

const SOURCE_ID = 'opencode'
const PARSER_VERSION = '1'
const DB_NAME = 'opencode.db'
const HISTORY_BATCH = 1000
const RUNTIME_RECENT_ROWS = 500
const RUNTIME_POLL_MS = 2000
const MAX_STRING = 64 * 1024
const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie)/i

interface OpenCodeRow {
  row_id: number
  id: string | null
  message_id: string | null
  session_id: string | null
  time_created: number | string | null
  data: string | null
  message_data: string | null
  directory: string | null
}

interface OpenCodeEnvelope {
  part: Record<string, unknown>
  message: Record<string, unknown>
  session: {
    nativeSessionId: string
    cwd?: string
  }
  captureChannel: 'history' | 'native-tail'
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function truncate(value: string, limit = MAX_STRING): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`
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

function parseRecord(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try { return asRecord(sanitize(JSON.parse(value))) }
  catch { return { raw: truncate(value) } }
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value
    return new Date(millis).toISOString()
  }
  if (typeof value !== 'string' || !value) return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return normalizeTimestamp(numeric)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

function candidateRoots(env: Readonly<Record<string, string | undefined>>): string[] {
  const result: string[] = []
  const add = (value: string | undefined) => {
    const normalized = value?.trim()
    if (normalized && !result.includes(normalized)) result.push(normalized)
  }
  add(env.OPENCODE_HOME)
  if (process.platform === 'win32') {
    add(join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'opencode'))
  } else {
    add(join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode'))
  }
  add(join(homedir(), '.local', 'share', 'opencode'))
  return result
}

export async function detectOpenCode(ctx: SourceDetectionContext): Promise<DetectedSource[]> {
  const env = ctx.env ?? process.env
  for (const root of candidateRoots(env)) {
    const dbPath = join(root, DB_NAME)
    if (!await exists(dbPath)) continue
    return [{
      sourceId: SOURCE_ID,
      productId: SOURCE_ID,
      configRoot: root,
      dataRoot: root,
      confidence: 'exact',
    }]
  }
  return []
}

function openDatabase(root: string): Database.Database {
  const db = new Database(join(root, DB_NAME), { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 1500')
  return db
}

function selectRows(db: Database.Database, afterRowId: number, limit: number): OpenCodeRow[] {
  return db.prepare(`
    SELECT p.rowid AS row_id,
           p.id AS id,
           p.message_id AS message_id,
           p.session_id AS session_id,
           p.time_created AS time_created,
           p.data AS data,
           m.data AS message_data,
           s.directory AS directory
      FROM part p
      LEFT JOIN message m ON p.message_id = m.id
      LEFT JOIN session s ON p.session_id = s.id
     WHERE p.rowid > ?
     ORDER BY p.rowid ASC
     LIMIT ?
  `).all(afterRowId, limit) as OpenCodeRow[]
}

function recentRows(db: Database.Database, limit: number): OpenCodeRow[] {
  const rows = db.prepare(`
    SELECT p.rowid AS row_id,
           p.id AS id,
           p.message_id AS message_id,
           p.session_id AS session_id,
           p.time_created AS time_created,
           p.data AS data,
           m.data AS message_data,
           s.directory AS directory
      FROM part p
      LEFT JOIN message m ON p.message_id = m.id
      LEFT JOIN session s ON p.session_id = s.id
     ORDER BY p.rowid DESC
     LIMIT ?
  `).all(limit) as OpenCodeRow[]
  return rows.reverse()
}

function rowFingerprint(row: OpenCodeRow): string {
  return sha256(JSON.stringify([
    row.id, row.message_id, row.session_id, row.time_created,
    row.data, row.message_data, row.directory,
  ]))
}

function recordFromRow(
  row: OpenCodeRow,
  ctx: SourceExecutionContext,
  captureChannel: OpenCodeEnvelope['captureChannel'],
): SourceRecord {
  const part = parseRecord(row.data)
  const message = parseRecord(row.message_data)
  const nativeSessionId = row.session_id || stringField(message, 'sessionID', 'session_id') || 'unknown'
  const nativeType = stringField(part, 'type') ?? 'unknown'
  const fingerprint = rowFingerprint(row)
  const capturedAt = new Date().toISOString()
  const occurredAt = normalizeTimestamp(row.time_created) ?? capturedAt
  const nativeId = row.id || `row-${row.row_id}`
  const dbPath = join(ctx.installation.dataRoot ?? ctx.installation.configRoot ?? '', DB_NAME)

  return {
    id: `opencode-${sha256(`${nativeId}:${fingerprint}`).slice(0, 32)}`,
    sourceId: SOURCE_ID,
    installationId: ctx.installation.id,
    sourceSessionNativeId: nativeSessionId,
    nativeType: `part/${nativeType}`,
    nativeId,
    sourceSequence: row.row_id * 10,
    occurredAt,
    capturedAt,
    locator: {
      kind: 'database',
      path: dbPath,
      table: 'part',
      rowId: String(row.row_id),
    },
    fingerprint,
    payload: {
      part,
      message,
      session: {
        nativeSessionId,
        ...(row.directory ? { cwd: row.directory } : {}),
      },
      captureChannel,
    } satisfies OpenCodeEnvelope,
    parserVersion: PARSER_VERSION,
  }
}

export async function* ingestOpenCodeHistory(
  ctx: SourceExecutionContext,
): AsyncIterable<SourceRecord> {
  const root = ctx.installation.dataRoot ?? ctx.installation.configRoot
  if (!root || ctx.abortSignal.aborted) return
  const db = openDatabase(root)
  try {
    let rowId = await ctx.checkpoint.get<number>('history-rowid') ?? 0
    while (!ctx.abortSignal.aborted) {
      const rows = selectRows(db, rowId, HISTORY_BATCH)
      if (!rows.length) break
      for (const row of rows) {
        if (ctx.abortSignal.aborted) return
        yield recordFromRow(row, ctx, 'history')
        rowId = row.row_id
        await ctx.checkpoint.set('history-rowid', rowId)
      }
      if (rows.length < HISTORY_BATCH) break
    }
  } finally {
    db.close()
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export async function startOpenCodeRuntimeCapture(
  ctx: SourceExecutionContext,
  emitter: SourceRecordEmitter,
): Promise<Disposable> {
  const root = ctx.installation.dataRoot ?? ctx.installation.configRoot
  if (!root) return { dispose() {} }
  const dbPath = join(root, DB_NAME)
  const db = openDatabase(root)
  const fingerprints = new Map<number, string>()
  let stopped = false
  let scanning = false
  let pending = false
  let watcher: FSWatcher | null = null

  const scan = async (emitChanges: boolean): Promise<void> => {
    if (scanning) { pending = true; return }
    scanning = true
    try {
      do {
        pending = false
        const rows = recentRows(db, RUNTIME_RECENT_ROWS)
        const live = new Set<number>()
        for (const row of rows) {
          live.add(row.row_id)
          const fingerprint = rowFingerprint(row)
          const previous = fingerprints.get(row.row_id)
          fingerprints.set(row.row_id, fingerprint)
          if (emitChanges && previous !== undefined && previous !== fingerprint) {
            await emitter.emit(recordFromRow(row, ctx, 'native-tail'))
          } else if (emitChanges && previous === undefined) {
            await emitter.emit(recordFromRow(row, ctx, 'native-tail'))
          }
        }
        for (const rowId of fingerprints.keys()) {
          if (!live.has(rowId)) fingerprints.delete(rowId)
        }
      } while (pending && !stopped && !ctx.abortSignal.aborted)
    } finally {
      scanning = false
    }
  }

  await scan(false)
  try {
    watcher = watch(dirname(dbPath), (_event, fileName) => {
      const name = fileName?.toString() ?? ''
      if (!name.startsWith(DB_NAME)) return
      void scan(true).catch(() => undefined)
    })
    watcher.on('error', () => { watcher?.close(); watcher = null })
  } catch {
    watcher = null
  }

  const task = (async () => {
    while (!stopped && !ctx.abortSignal.aborted) {
      await sleep(RUNTIME_POLL_MS, ctx.abortSignal)
      if (!stopped && !ctx.abortSignal.aborted) await scan(true).catch(() => undefined)
    }
  })()

  return {
    async dispose(): Promise<void> {
      if (stopped) return
      stopped = true
      watcher?.close()
      watcher = null
      await task
      db.close()
    },
  }
}

function evidenceFor(record: SourceRecord, envelope: OpenCodeEnvelope): EvidenceCandidate {
  return {
    captureMethod: 'native-db',
    derivation: 'reported',
    sourceRecordId: record.id,
    sourceLocator: record.locator,
    parserVersion: record.parserVersion,
    ...(record.nativeId ? { nativeStableId: record.nativeId } : {}),
    ...(record.occurredAt ? { eventTime: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    confidenceHint: envelope.captureChannel === 'history' ? 'exact' : 'high',
  }
}

function identity(record: SourceRecord, envelope: OpenCodeEnvelope): ObservationIdentityHints {
  return {
    nativeSessionId: envelope.session.nativeSessionId || record.sourceSessionNativeId || 'unknown',
    ...(envelope.session.cwd ? { workspacePath: envelope.session.cwd } : {}),
  }
}

function candidate(
  record: SourceRecord,
  envelope: OpenCodeEnvelope,
  kind: ObservationCandidate['kind'],
  payload: unknown,
  options: { nativeCallId?: string; nativeEventId?: string; offset?: number } = {},
): ObservationCandidate {
  const nativeCallId = options.nativeCallId
  const nativeEventId = options.nativeEventId ?? (!nativeCallId ? record.nativeId : undefined)
  const sourceSequence = record.sourceSequence === undefined ? undefined : record.sourceSequence + (options.offset ?? 0)
  return {
    kind,
    ...(nativeCallId ? { nativeCallId } : {}),
    ...(nativeEventId ? { nativeEventId } : {}),
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
    ...(record.occurredAt ? { occurredAt: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    payload,
    identityHints: identity(record, envelope),
    dedupHints: {
      ...(nativeCallId ? { nativeCallId } : {}),
      ...(nativeEventId ? { nativeEventId } : {}),
      ...(sourceSequence === undefined ? {} : { sourceSequence }),
      ...(record.fingerprint ? { payloadFingerprint: record.fingerprint } : {}),
    },
  }
}

function toolSuccess(state: Record<string, unknown>): boolean | undefined {
  const status = stringField(state, 'status')
  if (!status) return undefined
  if (['completed', 'complete', 'ok', 'success'].includes(status)) return true
  if (['error', 'failed', 'cancelled', 'canceled'].includes(status)) return false
  return undefined
}

export async function normalizeOpenCodeRecord(
  record: SourceRecord,
  _ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  const envelope = record.payload as OpenCodeEnvelope
  const part = asRecord(envelope.part)
  const message = asRecord(envelope.message)
  const type = stringField(part, 'type') ?? 'unknown'
  const role = stringField(message, 'role') ?? 'unknown'
  const observations: ObservationCandidate[] = []

  if (type === 'text') {
    const text = stringField(part, 'text', 'content') ?? ''
    if (role === 'user') observations.push(candidate(record, envelope, 'message.user', { text: truncate(text) }))
    else if (role === 'assistant') {
      const model = stringField(message, 'modelID', 'model_id', 'model')
      observations.push(candidate(record, envelope, 'message.assistant', {
        text: truncate(text),
        ...(model ? { model } : {}),
      }))
    } else observations.push(candidate(record, envelope, 'unknown', { rawType: `text/${role}`, rawPayload: part }))
  } else if (type === 'reasoning') {
    observations.push(candidate(record, envelope, 'message.reasoning', {
      text: truncate(stringField(part, 'text', 'content') ?? ''),
    }))
  } else if (type === 'tool') {
    const state = asRecord(part.state)
    const callId = stringField(part, 'callID', 'callId', 'call_id') ?? record.nativeId ?? `opencode-call-${record.id}`
    const toolName = stringField(part, 'tool', 'name') ?? 'unknown'
    observations.push(candidate(record, envelope, 'tool.call', {
      callId,
      nativeToolName: toolName,
      input: sanitize(state.input ?? part.input ?? {}),
    }, { nativeCallId: callId, offset: 0 }))

    const success = toolSuccess(state)
    if (success !== undefined || state.output !== undefined || state.error !== undefined) {
      observations.push(candidate(record, envelope, 'tool.result', {
        callId,
        nativeToolName: toolName,
        ...(success === undefined ? {} : { success }),
        output: sanitize(state.output ?? state.error ?? ''),
        ...(stringField(state, 'status') ? { status: stringField(state, 'status') } : {}),
      }, { nativeCallId: callId, offset: 1 }))
    }
  } else if (type === 'step-start') {
    observations.push(candidate(record, envelope, 'session.lifecycle', { event: 'step.started' }))
  } else if (type === 'step-finish') {
    observations.push(candidate(record, envelope, 'session.lifecycle', { event: 'step.finished' }))
  } else {
    observations.push(candidate(record, envelope, 'unknown', {
      rawType: `part/${type}`,
      rawPayload: part,
    }))
  }

  return { observations, evidenceCandidates: [evidenceFor(record, envelope)] }
}

export async function declareOpenCodeCapabilities(
  _detected: DetectedSource,
): Promise<ObservationCapability[]> {
  return [
    { sourceId: SOURCE_ID, name: 'session', status: 'partial', captureModes: ['history', 'native-tail'], reason: 'Session identity and step lifecycle come from the native SQLite store' },
    { sourceId: SOURCE_ID, name: 'transcript', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'tool-call', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'tool-result', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'thinking', status: 'partial', captureModes: ['history', 'native-tail'], reason: 'Only source-visible reasoning parts are retained' },
    { sourceId: SOURCE_ID, name: 'asset-discovery', status: 'unavailable', captureModes: [], reason: 'No stable OpenCode asset inventory mapping has been proven for 1.0 yet' },
    { sourceId: SOURCE_ID, name: 'permission', status: 'unavailable', captureModes: [], reason: 'Permission lifecycle mapping is not implemented' },
    { sourceId: SOURCE_ID, name: 'subagent', status: 'unavailable', captureModes: [], reason: 'Subagent lifecycle mapping is not implemented' },
    { sourceId: SOURCE_ID, name: 'usage', status: 'unavailable', captureModes: [], reason: 'Usage mapping is not implemented' },
    { sourceId: SOURCE_ID, name: 'context', status: 'partial', captureModes: ['history'], reason: 'Compaction parts are retained as unknown until their schema is proven' },
    { sourceId: SOURCE_ID, name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: 'Asset attribution is not implemented' },
    { sourceId: SOURCE_ID, name: 'artifact-action', status: 'unavailable', captureModes: [], reason: 'Artifact attribution is not implemented' },
  ]
}

export const openCodeManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-opencode',
  pluginVersion: '1.0.0-alpha.1',
  apiVersion: '1.0',
  pluginType: 'source',
  displayName: 'OpenCode Source',
  sourceId: SOURCE_ID,
  productId: SOURCE_ID,
  parserVersion: PARSER_VERSION,
}

export const openCodeSourceDefinition: SourceDefinition = {
  manifest: openCodeManifest,
  detect: detectOpenCode,
  declareCapabilities: declareOpenCodeCapabilities,
  ingestHistory: ingestOpenCodeHistory,
  startCapture: startOpenCodeRuntimeCapture,
  normalize: normalizeOpenCodeRecord,
}

const applyOpenCodeSource = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.sources.register(openCodeSourceDefinition)
    return () => registration.dispose()
  },
  { inject: ['sources'] },
)

export const openCodeSourcePlugin = defineAgentLensPlugin(openCodeManifest, applyOpenCodeSource)

export const openCodeSourceInternals = {
  candidateRoots,
  normalizeTimestamp,
  rowFingerprint,
  recordFromRow,
}
