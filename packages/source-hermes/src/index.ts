import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import {
  access,
  mkdir,
  readFile,
  readdir,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import {
  evidenceFromSourceRecord,
  observationFromSourceRecord,
  type DetectedSource,
  type Disposable,
  type EvidenceCandidate,
  type NormalizedSourceOutput,
  type ObservationCapability,
  type ObservationCandidate,
  type ObservationIdentityHints,
  type SourceDefinition,
  type SourceDetectionContext,
  type SourceExecutionContext,
  type SourceHistoryExecutionContext,
  type SourceNormalizationContext,
  type SourcePluginManifest,
  type SourceRecord,
  type SourceRecordEmitter,
} from '@agent-lens/core'
import {
  HERMES_STATE_DB_NAME as DB_NAME,
  abortableDelay,
  defineAgentLensPlugin,
  resolveHermesConfigRoots,
  resolveHermesRoots,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import { isMissingPathError } from '@agent-lens/source-support'
import {
  discoverHermesAssets,
  hermesAssetInternals,
} from './assets.js'
import { HERMES_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY } from './workspace-context.js'
import { hermesRow, tableColumnName, type HermesRow } from './sqlite-rows.js'

const SOURCE_ID = 'hermes'
const PARSER_VERSION = '3'

const HISTORY_BATCH = 1000
const RUNTIME_RECENT_ROWS = 500
const DB_POLL_MS = 2000
const INBOX_POLL_MS = 250

interface HermesDbEnvelope {
  message: Record<string, unknown>
  session: { nativeSessionId?: string; cwd?: string; title?: string }
  captureChannel?: 'history' | 'native-tail'
}

interface HermesHookEnvelope {
  runtimeEvent: Record<string, unknown>
  session: { nativeSessionId?: string; cwd?: string }
  captureChannel: 'runtime-hook'
}

type HermesEnvelope = HermesDbEnvelope | HermesHookEnvelope

interface InboxEnvelope {
  id: string
  capturedAt: string
  event: Record<string, unknown>
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}


function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined
  try { return JSON.parse(value) }
  catch { return value }
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function hermesEnvelope(value: unknown, record: SourceRecord): HermesEnvelope {
  const payload = asRecord(value)
  const session = asRecord(payload.session)
  const storedSessionId = stringField(session, 'nativeSessionId') ?? record.sourceSessionNativeId
  const nativeSessionId = storedSessionId === 'unknown' || storedSessionId === 'runtime-unknown'
    ? undefined
    : storedSessionId
  const cwd = stringField(session, 'cwd')

  if (payload.captureChannel === 'runtime-hook') {
    return {
      runtimeEvent: asRecord(payload.runtimeEvent),
      session: { ...(nativeSessionId ? { nativeSessionId } : {}), ...(cwd ? { cwd } : {}) },
      captureChannel: 'runtime-hook',
    }
  }

  const title = stringField(session, 'title')
  const captureChannel = payload.captureChannel === 'history' || payload.captureChannel === 'native-tail'
    ? payload.captureChannel
    : undefined
  return {
    message: asRecord(payload.message),
    session: {
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(title ? { title } : {}),
    },
    ...(captureChannel ? { captureChannel } : {}),
  }
}

function isHermesHookEnvelope(envelope: HermesEnvelope): envelope is HermesHookEnvelope {
  return envelope.captureChannel === 'runtime-hook'
}

function envelopeNativeEventId(envelope: HermesEnvelope): string | undefined {
  if (isHermesHookEnvelope(envelope)) {
    return stringField(envelope.runtimeEvent, 'source_event_id', 'hook_invocation_id')
  }
  const value = envelope.message.id
  if (typeof value === 'string' && value) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
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
  try {
    await access(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

export async function detectHermes(ctx: SourceDetectionContext): Promise<DetectedSource[]> {
  const env = ctx.env ?? process.env
  const roots = resolveHermesRoots(env)
  let dataRoot: string | undefined
  for (const root of roots) {
    if (await exists(join(root, DB_NAME))) { dataRoot = root; break }
  }
  let configRoot: string | undefined
  for (const root of resolveHermesConfigRoots(env)) {
    if (await exists(root)) { configRoot = root; break }
  }
  configRoot ??= dataRoot
  if (!dataRoot && !configRoot) return []
  return [{
    sourceId: SOURCE_ID,
    productId: SOURCE_ID,
    ...(configRoot ? { configRoot } : {}),
    ...(dataRoot ? { dataRoot } : {}),
    confidence: dataRoot ? 'exact' : 'high',
  }]
}

function openDatabase(root: string): Database.Database {
  const db = new Database(join(root, DB_NAME), { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 1500')
  return db
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const names = db.prepare(`PRAGMA table_info(${table})`).all()
    .map(tableColumnName)
    .filter((name): name is string => name !== undefined)
  return new Set(names)
}

function columnExpr(columns: Set<string>, tableAlias: string, column: string, alias = column): string {
  return columns.has(column) ? `${tableAlias}."${column}" AS "${alias}"` : `NULL AS "${alias}"`
}

function timestampMillisSql(column: string): string {
  return `CASE
    WHEN typeof(${column}) IN ('integer', 'real') THEN
      CASE WHEN CAST(${column} AS REAL) < 10000000000 THEN CAST(${column} AS REAL) * 1000 ELSE CAST(${column} AS REAL) END
    WHEN trim(CAST(${column} AS TEXT)) <> '' AND trim(CAST(${column} AS TEXT)) NOT GLOB '*[^0-9.]*' THEN
      CASE WHEN CAST(${column} AS REAL) < 10000000000 THEN CAST(${column} AS REAL) * 1000 ELSE CAST(${column} AS REAL) END
    ELSE CAST(strftime('%s', ${column}) AS REAL) * 1000
  END`
}

function messageQuery(
  db: Database.Database,
  tail: boolean,
  activeSinceMs?: number,
  sessionLimit?: number,
): Database.Statement {
  const messageColumns = tableColumns(db, 'messages')
  if (!messageColumns.has('session_id')) throw new Error('Hermes state.db messages table has no session_id column')
  const sessionColumns = tableColumns(db, 'sessions')
  const fields = [
    'm.rowid AS row_id',
    columnExpr(messageColumns, 'm', 'id'),
    columnExpr(messageColumns, 'm', 'session_id'),
    columnExpr(messageColumns, 'm', 'role'),
    columnExpr(messageColumns, 'm', 'content'),
    columnExpr(messageColumns, 'm', 'timestamp'),
    columnExpr(messageColumns, 'm', 'tool_calls'),
    columnExpr(messageColumns, 'm', 'tool_call_id'),
    columnExpr(messageColumns, 'm', 'tool_name'),
    sessionColumns.has('cwd') ? 's.cwd AS cwd' : 'NULL AS cwd',
    sessionColumns.has('title') ? 's.title AS session_title' : 'NULL AS session_title',
  ]
  const joinSession = sessionColumns.has('id')
    ? 'LEFT JOIN sessions s ON m.session_id = s.id'
    : 'LEFT JOIN (SELECT NULL AS id, NULL AS cwd, NULL AS title) s ON 1 = 0'
  const order = tail ? 'DESC' : 'ASC'
  const filters: string[] = []
  if (!tail) {
    filters.push('m.rowid > ?')
    if (activeSinceMs !== undefined) {
      filters.push(messageColumns.has('timestamp') ? `${timestampMillisSql('m.timestamp')} >= ?` : '1 = 0')
    }
    if (sessionLimit !== undefined) {
      const recentTimeFilter = activeSinceMs === undefined
        ? ''
        : messageColumns.has('timestamp')
          ? `WHERE ${timestampMillisSql('recent.timestamp')} >= ?`
          : 'WHERE 1 = 0'
      filters.push(`m.session_id IN (
        SELECT recent.session_id FROM messages recent
        ${recentTimeFilter}
        GROUP BY recent.session_id
        ORDER BY MAX(${messageColumns.has('timestamp') ? timestampMillisSql('recent.timestamp') : 'recent.rowid'}) DESC,
                 recent.session_id ASC
        LIMIT ?
      )`)
    }
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
  const sql = `SELECT ${fields.join(', ')} FROM messages m ${joinSession} ${where} ORDER BY m.rowid ${order} LIMIT ?`
  return db.prepare(sql)
}

function selectRows(
  db: Database.Database,
  afterRowId: number,
  limit: number,
  activeSinceMs?: number,
  sessionLimit?: number,
): HermesRow[] {
  const statement = messageQuery(db, false, activeSinceMs, sessionLimit)
  const params: unknown[] = [afterRowId]
  if (activeSinceMs !== undefined) params.push(activeSinceMs)
  if (sessionLimit !== undefined) {
    if (activeSinceMs !== undefined) params.push(activeSinceMs)
    params.push(Math.max(0, Math.floor(sessionLimit)))
  }
  params.push(limit)
  return statement.all(...params).map(hermesRow)
}

function recentRows(db: Database.Database, limit: number): HermesRow[] {
  const statement = messageQuery(db, true)
  return statement.all(limit).map(hermesRow).reverse()
}

function rowFingerprint(row: HermesRow): string {
  return sha256(JSON.stringify([
    row.id, row.session_id, row.role, row.content, row.timestamp,
    row.tool_calls, row.tool_call_id, row.tool_name, row.cwd, row.session_title,
  ]))
}

function dbRecord(
  row: HermesRow,
  ctx: SourceExecutionContext,
  captureChannel: NonNullable<HermesDbEnvelope['captureChannel']>,
): SourceRecord {
  const nativeSessionId = row.session_id ?? undefined
  const fingerprint = rowFingerprint(row)
  const nativeId = row.id == null ? undefined : String(row.id)
  const recordKey = nativeId ?? `row:${row.row_id}`
  const capturedAt = new Date().toISOString()
  const occurredAt = normalizeTimestamp(row.timestamp)
  const dbPath = join(ctx.installation.dataRoot ?? '', DB_NAME)
  const title = row.session_title?.trim() || undefined
  const message = {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: parseJson(row.content),
    raw_content: row.content,
    timestamp: row.timestamp,
    tool_calls: parseJson(row.tool_calls),
    tool_call_id: row.tool_call_id,
    tool_name: row.tool_name,
  }

  return {
    id: `hermes-db-${sha256(`${recordKey}:${fingerprint}`).slice(0, 32)}`,
    sourceId: SOURCE_ID,
    installationId: ctx.installation.id,
    ...(nativeSessionId ? { sourceSessionNativeId: nativeSessionId } : {}),
    nativeType: `message/${row.role ?? 'unknown'}`,
    ...(nativeId ? { nativeId } : {}),
    sourceSequence: row.row_id * 10,
    ...(occurredAt ? { occurredAt } : {}),
    capturedAt,
    locator: { kind: 'database', path: dbPath, table: 'messages', rowId: String(row.row_id) },
    fingerprint,
    payload: {
      message,
      session: {
        ...(nativeSessionId ? { nativeSessionId } : {}),
        ...(row.cwd ? { cwd: row.cwd } : {}),
        ...(title ? { title } : {}),
      },
      captureChannel,
    } satisfies HermesDbEnvelope,
    parserVersion: PARSER_VERSION,
  }
}

export async function* ingestHermesHistory(ctx: SourceHistoryExecutionContext): AsyncIterable<SourceRecord> {
  const root = ctx.installation.dataRoot
  if (!root || ctx.abortSignal.aborted || !await exists(join(root, DB_NAME))) return

  const remembered = await ctx.checkpoint.get<string[]>(HERMES_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY) ?? []
  const knownProjectCwds = new Map<string, string>()
  for (const value of remembered) {
    const raw = value.trim()
    if (!raw || !isAbsolute(raw)) continue
    const cwd = resolve(raw)
    const key = process.platform === 'win32'
      ? cwd.replaceAll('\\', '/').toLowerCase()
      : cwd.replaceAll('\\', '/')
    if (!knownProjectCwds.has(key)) knownProjectCwds.set(key, cwd)
  }

  const rememberWorkspace = (value: string | null) => {
    const raw = value?.trim()
    if (!raw || !isAbsolute(raw)) return
    const cwd = resolve(raw)
    const key = process.platform === 'win32'
      ? cwd.replaceAll('\\', '/').toLowerCase()
      : cwd.replaceAll('\\', '/')
    if (!knownProjectCwds.has(key)) knownProjectCwds.set(key, cwd)
  }

  const db = openDatabase(root)
  try {
    const parsedActiveSince = ctx.historyWindow?.activeSince ? Date.parse(ctx.historyWindow.activeSince) : Number.NaN
    const activeSinceMs = Number.isFinite(parsedActiveSince) ? parsedActiveSince : undefined
    const sessionLimit = ctx.historyWindow?.sessionLimit
    const checkpointKey = activeSinceMs === undefined
      ? 'history-rowid:v2-session-title'
      : sessionLimit === undefined
        ? 'history-hot-rowid:v1'
        : `history-hot-limit-${Math.max(0, Math.floor(sessionLimit))}-rowid:v1`
    let rowId = await ctx.checkpoint.get<number>(checkpointKey) ?? 0
    while (!ctx.abortSignal.aborted) {
      const rows = selectRows(db, rowId, HISTORY_BATCH, activeSinceMs, sessionLimit)
      if (!rows.length) break
      for (const row of rows) {
        if (ctx.abortSignal.aborted) return
        rememberWorkspace(row.cwd)
        yield dbRecord(row, ctx, 'history')
        rowId = row.row_id
        await ctx.checkpoint.set(checkpointKey, rowId)
      }
      if (rows.length < HISTORY_BATCH) break
    }
  } finally {
    db.close()
  }

  if (!ctx.abortSignal.aborted) {
    await ctx.checkpoint.set(
      HERMES_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY,
      [...knownProjectCwds.values()],
    )
  }
}
function hermesInboxDirectory(): string {
  return process.env.AGENT_LENS_HERMES_INBOX
    ?? join(homedir(), '.agent-lens', '1.0', 'inbox', 'hermes')
}

function parseInboxEnvelope(text: string, fileName: string): InboxEnvelope {
  try {
    const parsed = asRecord(JSON.parse(text))
    return {
      id: stringField(parsed, 'id') ?? fileName,
      capturedAt: stringField(parsed, 'capturedAt') ?? new Date().toISOString(),
      event: asRecord(parsed.event),
    }
  } catch {
    return {
      id: fileName,
      capturedAt: new Date().toISOString(),
      event: { hook_event_name: 'malformed', raw: text },
    }
  }
}

function hookSessionId(event: Record<string, unknown>): string | undefined {
  return stringField(event, 'session_id', 'task_id', 'session_key')
}

function hookCallId(event: Record<string, unknown>): string | undefined {
  return stringField(event, 'tool_call_id', 'call_id', 'tool_use_id')
}

function hookSharedCallKey(event: Record<string, unknown>, recordId: string): string {
  const request = stringField(event, 'api_request_id')
  const tool = stringField(event, 'tool_name')
  return request && tool
    ? `hermes-hook:${request}:${String(event.api_call_count ?? '')}:${tool}`
    : `hermes-hook:${recordId}`
}

function hookRecord(envelope: InboxEnvelope, filePath: string, ctx: SourceExecutionContext): SourceRecord {
  const event = envelope.event
  const eventName = stringField(event, 'hook_event_name', 'event_name', 'type') ?? 'unknown'
  const sessionId = hookSessionId(event)
  const nativeId = stringField(event, 'source_event_id', 'hook_invocation_id')
  const occurredAt = normalizeTimestamp(event.timestamp ?? event.ts) ?? envelope.capturedAt
  const cwd = stringField(event, 'cwd', 'working_directory', 'workdir')
  return {
    id: `hermes-hook-${sha256(envelope.id).slice(0, 32)}`,
    sourceId: SOURCE_ID,
    installationId: ctx.installation.id,
    ...(sessionId ? { sourceSessionNativeId: sessionId } : {}),
    nativeType: `hook/${eventName}`,
    ...(nativeId ? { nativeId } : {}),
    occurredAt,
    capturedAt: envelope.capturedAt,
    locator: { kind: 'runtime-hook', path: filePath, hookEventId: envelope.id },
    fingerprint: sha256(JSON.stringify(event)),
    payload: {
      runtimeEvent: event,
      session: { ...(sessionId ? { nativeSessionId: sessionId } : {}), ...(cwd ? { cwd } : {}) },
      captureChannel: 'runtime-hook',
    } satisfies HermesHookEnvelope,
    parserVersion: PARSER_VERSION,
  }
}

export async function startHermesRuntimeCapture(
  ctx: SourceExecutionContext,
  emitter: SourceRecordEmitter,
): Promise<Disposable> {
  const inbox = hermesInboxDirectory()
  await mkdir(inbox, { recursive: true })
  const dataRoot = ctx.installation.dataRoot
  const hasDb = Boolean(dataRoot && await exists(join(dataRoot, DB_NAME)))
  const db = hasDb && dataRoot ? openDatabase(dataRoot) : null
  const fingerprints = new Map<number, string>()
  let watcher: FSWatcher | null = null
  let stopped = false
  let scanning = false
  let pending = false

  const scanDb = async (emitChanges: boolean): Promise<void> => {
    if (!db) return
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
          if (emitChanges && previous !== fingerprint) await emitter.emit(dbRecord(row, ctx, 'native-tail'))
        }
        for (const rowId of fingerprints.keys()) if (!live.has(rowId)) fingerprints.delete(rowId)
      } while (pending && !stopped && !ctx.abortSignal.aborted)
    } finally {
      scanning = false
    }
  }

  if (db && dataRoot) {
    await scanDb(false)
    try {
      watcher = watch(dataRoot, (_event, fileName) => {
        const name = fileName?.toString() ?? ''
        if (!name.startsWith(DB_NAME)) return
        void scanDb(true).catch(() => undefined)
      })
      watcher.on('error', () => { watcher?.close(); watcher = null })
    } catch {
      watcher = null
    }
  }

  const inboxTask = (async () => {
    while (!stopped && !ctx.abortSignal.aborted) {
      let files: string[] = []
      try {
        files = (await readdir(inbox)).filter(name => name.endsWith('.json')).sort((a, b) => a.localeCompare(b))
      } catch (error) {
        if (!isMissingPathError(error)) throw error
        files = []
      }
      for (const fileName of files) {
        if (stopped || ctx.abortSignal.aborted) break
        const filePath = join(inbox, fileName)
        try {
          const envelope = parseInboxEnvelope(await readFile(filePath, 'utf8'), fileName)
          await emitter.emit(hookRecord(envelope, filePath, ctx))
          await unlink(filePath)
        } catch {
          break
        }
      }
      await abortableDelay(INBOX_POLL_MS, ctx.abortSignal)
    }
  })()

  const dbTask = (async () => {
    while (!stopped && !ctx.abortSignal.aborted) {
      await abortableDelay(DB_POLL_MS, ctx.abortSignal)
      if (!stopped && !ctx.abortSignal.aborted) await scanDb(true).catch(() => undefined)
    }
  })()

  return {
    async dispose(): Promise<void> {
      if (stopped) return
      stopped = true
      watcher?.close()
      watcher = null
      await Promise.all([inboxTask, dbTask])
      db?.close()
    },
  }
}

function evidenceFor(record: SourceRecord, envelope: HermesEnvelope): EvidenceCandidate {
  const runtime = isHermesHookEnvelope(envelope)
  const nativeStableId = envelopeNativeEventId(envelope)
  return evidenceFromSourceRecord(record, {
    captureMethod: runtime ? 'runtime-hook' : 'native-db',
    derivation: runtime ? 'observed' : 'reported',
    ...(nativeStableId ? { nativeStableId } : {}),
    ...(runtime
      ? { confidenceHint: 'high' as const }
      : envelope.captureChannel
        ? { confidenceHint: 'exact' as const }
        : {}),
  })
}

function identity(_record: SourceRecord, envelope: HermesEnvelope): ObservationIdentityHints {
  if (!envelope.session.nativeSessionId) {
    throw new Error('Hermes observation requires a proven native session id')
  }
  return {
    nativeSessionId: envelope.session.nativeSessionId,
    ...(envelope.session.cwd ? { workspacePath: envelope.session.cwd } : {}),
    ...('title' in envelope.session && envelope.session.title?.trim()
      ? { sessionTitle: envelope.session.title.trim() }
      : {}),
  }
}

function candidate(
  record: SourceRecord,
  envelope: HermesEnvelope,
  kind: ObservationCandidate['kind'],
  payload: unknown,
  options: {
    nativeCallId?: string
    nativeEventId?: string
    sharedEventKey?: string
    offset?: number
  } = {},
): ObservationCandidate {
  const nativeEventId = options.nativeEventId
    ?? (!options.nativeCallId && !options.sharedEventKey ? envelopeNativeEventId(envelope) : undefined)
  return observationFromSourceRecord(record, {
    kind,
    payload,
    identityHints: identity(record, envelope),
    ...(options.nativeCallId ? { nativeCallId: options.nativeCallId } : {}),
    ...(nativeEventId ? { nativeEventId } : {}),
    ...(options.sharedEventKey ? { sharedEventKey: options.sharedEventKey } : {}),
    sequenceOffset: options.offset ?? 0,
  })
}

function toolCalls(value: unknown): Record<string, unknown>[] {
  const parsed = typeof value === 'string' ? parseJson(value) : value
  return Array.isArray(parsed) ? parsed.map(asRecord) : []
}

function toolCallParts(call: Record<string, unknown>): { callId?: string; toolName: string; input: unknown } {
  const fn = asRecord(call.function)
  const callId = stringField(call, 'id', 'call_id', 'tool_call_id')
  const toolName = stringField(fn, 'name') ?? stringField(call, 'name', 'tool_name') ?? 'unknown'
  let input: unknown = fn.arguments ?? call.arguments ?? call.args ?? {}
  if (typeof input === 'string') input = parseJson(input)
  return { ...(callId ? { callId } : {}), toolName, input }
}

function contentText(message: Record<string, unknown>): string {
  const raw = message.raw_content
  if (typeof raw === 'string') return raw
  const content = message.content
  if (typeof content === 'string') return content
  if (content == null) return ''
  return typeof content === 'object' ? JSON.stringify(content) : String(content)
}

function resultSuccess(content: unknown): boolean | undefined {
  const record = asRecord(content)
  if (typeof record.success === 'boolean') return record.success
  if (typeof record.exit_code === 'number') return record.exit_code === 0
  if (record.error != null) return false
  return undefined
}

function normalizeDbEnvelope(record: SourceRecord, envelope: HermesDbEnvelope): ObservationCandidate[] {
  const message = envelope.message
  const role = stringField(message, 'role') ?? 'unknown'
  const observations: ObservationCandidate[] = []
  if (role === 'user') {
    observations.push(candidate(record, envelope, 'message.user', { text: contentText(message) }))
  } else if (role === 'assistant') {
    const text = contentText(message)
    if (text) observations.push(candidate(record, envelope, 'message.assistant', { text }, { offset: 0 }))
    let offset = 1
    for (const call of toolCalls(message.tool_calls)) {
      const parts = toolCallParts(call)
      const callId = parts.callId
      observations.push(candidate(record, envelope, 'tool.call', {
        ...(callId ? { callId } : {}),
        nativeToolName: parts.toolName,
        input: parts.input,
      }, {
        ...(callId ? { nativeCallId: callId } : { sharedEventKey: `hermes-call:${record.id}:${offset}` }),
        offset: offset++,
      }))
    }
    if (!observations.length) observations.push(candidate(record, envelope, 'message.assistant', { text: '' }))
  } else if (role === 'tool') {
    const callId = stringField(message, 'tool_call_id')
    const content = message.content
    const success = resultSuccess(content)
    observations.push(candidate(record, envelope, 'tool.result', {
      ...(callId ? { callId } : {}),
      nativeToolName: stringField(message, 'tool_name') ?? 'unknown',
      ...(success === undefined ? {} : { success }),
      output: content ?? message.raw_content ?? '',
    }, {
      ...(callId ? { nativeCallId: callId } : { sharedEventKey: `hermes-result:${record.id}` }),
    }))
  } else {
    observations.push(candidate(record, envelope, 'unknown', { rawType: `message/${role}`, rawPayload: message }))
  }
  return observations
}

function normalizeHookEnvelope(record: SourceRecord, envelope: HermesHookEnvelope): ObservationCandidate[] {
  const event = envelope.runtimeEvent
  const eventName = stringField(event, 'hook_event_name', 'event_name', 'type') ?? 'unknown'
  const callId = hookCallId(event)
  const toolName = stringField(event, 'tool_name') ?? 'unknown'
  if (eventName === 'on_session_start' || eventName === 'session_start') {
    return [candidate(record, envelope, 'session.lifecycle', { event: 'session.started' })]
  }
  if (eventName === 'on_session_end' || eventName === 'session_end') {
    return [candidate(record, envelope, 'session.lifecycle', { event: 'session.ended' })]
  }
  if (eventName === 'pre_tool_call') {
    return [candidate(record, envelope, 'tool.call', {
      ...(callId ? { callId } : {}),
      nativeToolName: toolName,
      input: event.args ?? event.tool_input ?? {},
    }, {
      ...(callId
        ? { nativeCallId: callId }
        : { sharedEventKey: hookSharedCallKey(event, record.id) }),
    })]
  }
  if (eventName === 'post_tool_call') {
    const status = stringField(event, 'status')
    const success = status ? status === 'ok' : resultSuccess(parseJson(typeof event.result === 'string' ? event.result : null))
    return [candidate(record, envelope, 'tool.result', {
      ...(callId ? { callId } : {}),
      nativeToolName: toolName,
      ...(success === undefined ? {} : { success }),
      output: event.result ?? '',
      ...(typeof event.duration_ms === 'number' ? { durationMs: event.duration_ms } : {}),
      ...(status ? { status } : {}),
    }, {
      ...(callId
        ? { nativeCallId: callId }
        : { sharedEventKey: hookSharedCallKey(event, record.id) }),
    })]
  }
  if (eventName === 'pre_approval_request') {
    return [candidate(record, envelope, 'permission.request', event)]
  }
  if (eventName === 'post_approval_response') {
    return [candidate(record, envelope, 'permission.response', event)]
  }
  if (eventName === 'subagent_start') return [candidate(record, envelope, 'subagent.spawn', event)]
  if (eventName === 'subagent_stop') return [candidate(record, envelope, 'subagent.end', event)]
  return [candidate(record, envelope, 'unknown', { rawType: `hook/${eventName}`, rawPayload: event })]
}

export async function normalizeHermesRecord(
  record: SourceRecord,
  _ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  const envelope = hermesEnvelope(record.payload, record)
  if (!envelope.session.nativeSessionId) {
    return { observations: [], evidenceCandidates: [evidenceFor(record, envelope)] }
  }
  const observations = isHermesHookEnvelope(envelope)
    ? normalizeHookEnvelope(record, envelope)
    : normalizeDbEnvelope(record, envelope)
  return { observations, evidenceCandidates: [evidenceFor(record, envelope)] }
}

export async function declareHermesCapabilities(_detected: DetectedSource): Promise<ObservationCapability[]> {
  return [
    { sourceId: SOURCE_ID, name: 'session', status: 'available', captureModes: ['history', 'native-tail', 'runtime-hook'] },
    { sourceId: SOURCE_ID, name: 'transcript', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'tool-call', status: 'available', captureModes: ['history', 'native-tail', 'runtime-hook'] },
    { sourceId: SOURCE_ID, name: 'tool-result', status: 'available', captureModes: ['history', 'native-tail', 'runtime-hook'] },
    { sourceId: SOURCE_ID, name: 'permission', status: 'partial', captureModes: ['runtime-hook'], reason: 'Available when the optional AgentLens Hermes observer plugin is explicitly enabled' },
    { sourceId: SOURCE_ID, name: 'subagent', status: 'partial', captureModes: ['runtime-hook'], reason: 'Available when the optional AgentLens Hermes observer plugin is explicitly enabled' },
    { sourceId: SOURCE_ID, name: 'asset-discovery', status: 'partial', captureModes: ['static-scan'], reason: 'User-profile assets and history-known project context files are observable; runtime-loaded assets, external skill dirs, bundled/pip plugins and project plugins require stronger runtime evidence' },
    { sourceId: SOURCE_ID, name: 'thinking', status: 'unavailable', captureModes: [], reason: 'No stable source-visible reasoning mapping is implemented' },
    { sourceId: SOURCE_ID, name: 'context', status: 'unavailable', captureModes: [], reason: 'Context lifecycle mapping is not implemented' },
    { sourceId: SOURCE_ID, name: 'usage', status: 'unavailable', captureModes: [], reason: 'Usage mapping is not implemented' },
    { sourceId: SOURCE_ID, name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: 'Asset attribution is not implemented' },
    { sourceId: SOURCE_ID, name: 'artifact-action', status: 'unavailable', captureModes: [], reason: 'Artifact attribution is not implemented' },
  ]
}

export const hermesManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-hermes',
  pluginVersion: '1.0.0-alpha.5',
  apiVersion: '1.0',
  pluginType: 'source',
  displayName: 'Hermes Source',
  sourceId: SOURCE_ID,
  productId: SOURCE_ID,
  parserVersion: PARSER_VERSION,
}

export const hermesSourceDefinition: SourceDefinition = {
  manifest: hermesManifest,
  detect: detectHermes,
  declareCapabilities: declareHermesCapabilities,
  discoverAssets: discoverHermesAssets,
  ingestHistory: ingestHermesHistory,
  startCapture: startHermesRuntimeCapture,
  normalize: normalizeHermesRecord,
}

const applyHermesSource = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.sources.register(hermesSourceDefinition)
    return () => registration.dispose()
  },
  { inject: ['sources'] },
)

export const hermesSourcePlugin = defineAgentLensPlugin(hermesManifest, applyHermesSource)

export const hermesSourceInternals = {
  hermesRoots: resolveHermesRoots,
  hermesInboxDirectory,
  normalizeTimestamp,
  rowFingerprint,
  parseInboxEnvelope,
  hookRecord,
  parseHermesConfig: hermesAssetInternals.parseHermesConfig,
  boolLike: hermesAssetInternals.boolLike,
  selectRows,
  hermesEnvelope,
}

export * from './assets.js'
export * from './project-context.js'
export * from './workspace-context.js'
