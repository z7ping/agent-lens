import { createHash, randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import {
  access,
  mkdir,
  opendir,
  readFile,
  readdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import type {
  DetectedSource,
  DiscoveredAsset,
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

const SOURCE_ID = 'hermes'
const PARSER_VERSION = '1'
const DB_NAME = 'state.db'
const HISTORY_BATCH = 1000
const RUNTIME_RECENT_ROWS = 500
const DB_POLL_MS = 2000
const INBOX_POLL_MS = 250
const MAX_STRING = 64 * 1024
const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie)/i

interface HermesRow {
  row_id: number
  id: string | number | null
  session_id: string | null
  role: string | null
  content: string | null
  timestamp: number | string | null
  tool_calls: string | null
  tool_call_id: string | null
  tool_name: string | null
  cwd: string | null
}

interface HermesDbEnvelope {
  message: Record<string, unknown>
  session: { nativeSessionId: string; cwd?: string }
  captureChannel: 'history' | 'native-tail'
}

interface HermesHookEnvelope {
  runtimeEvent: Record<string, unknown>
  session: { nativeSessionId: string; cwd?: string }
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

function parseJson(value: string | null): unknown {
  if (!value) return undefined
  try { return sanitize(JSON.parse(value)) }
  catch { return truncate(value) }
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

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function hermesRoots(env: Readonly<Record<string, string | undefined>>): string[] {
  const explicit = env.HERMES_HOME?.trim()
  if (explicit) return [explicit]
  const result: string[] = []
  if (process.platform === 'win32') {
    result.push(join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'hermes'))
  }
  result.push(join(homedir(), '.hermes'))
  return unique(result)
}

export async function detectHermes(ctx: SourceDetectionContext): Promise<DetectedSource[]> {
  const env = ctx.env ?? process.env
  const roots = hermesRoots(env)
  let dataRoot: string | undefined
  for (const root of roots) {
    if (await exists(join(root, DB_NAME))) { dataRoot = root; break }
  }
  const configRoot = await exists(join(homedir(), '.hermes')) ? join(homedir(), '.hermes') : dataRoot
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
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
    return new Set(rows.map(row => row.name).filter((name): name is string => Boolean(name)))
  } catch {
    return new Set()
  }
}

function columnExpr(columns: Set<string>, tableAlias: string, column: string, alias = column): string {
  return columns.has(column) ? `${tableAlias}."${column}" AS "${alias}"` : `NULL AS "${alias}"`
}

function messageQuery(db: Database.Database, tail: boolean): Database.Statement<[number, number]> {
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
  ]
  const joinSession = sessionColumns.has('id')
    ? 'LEFT JOIN sessions s ON m.session_id = s.id'
    : 'LEFT JOIN (SELECT NULL AS id, NULL AS cwd) s ON 1 = 0'
  const order = tail ? 'DESC' : 'ASC'
  const where = tail ? '' : 'WHERE m.rowid > ?'
  const sql = `SELECT ${fields.join(', ')} FROM messages m ${joinSession} ${where} ORDER BY m.rowid ${order} LIMIT ?`
  return db.prepare(sql) as Database.Statement<[number, number]>
}

function selectRows(db: Database.Database, afterRowId: number, limit: number): HermesRow[] {
  return messageQuery(db, false).all(afterRowId, limit) as HermesRow[]
}

function recentRows(db: Database.Database, limit: number): HermesRow[] {
  const statement = messageQuery(db, true) as unknown as Database.Statement<[number]>
  return (statement.all(limit) as HermesRow[]).reverse()
}

function rowFingerprint(row: HermesRow): string {
  return sha256(JSON.stringify([
    row.id, row.session_id, row.role, row.content, row.timestamp,
    row.tool_calls, row.tool_call_id, row.tool_name, row.cwd,
  ]))
}

function dbRecord(
  row: HermesRow,
  ctx: SourceExecutionContext,
  captureChannel: HermesDbEnvelope['captureChannel'],
): SourceRecord {
  const nativeSessionId = row.session_id ?? 'unknown'
  const fingerprint = rowFingerprint(row)
  const nativeId = row.id == null ? `row-${row.row_id}` : String(row.id)
  const capturedAt = new Date().toISOString()
  const occurredAt = normalizeTimestamp(row.timestamp) ?? capturedAt
  const dbPath = join(ctx.installation.dataRoot ?? '', DB_NAME)
  const message = asRecord(sanitize({
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: parseJson(row.content),
    raw_content: row.content,
    timestamp: row.timestamp,
    tool_calls: parseJson(row.tool_calls),
    tool_call_id: row.tool_call_id,
    tool_name: row.tool_name,
  }))

  return {
    id: `hermes-db-${sha256(`${nativeId}:${fingerprint}`).slice(0, 32)}`,
    sourceId: SOURCE_ID,
    installationId: ctx.installation.id,
    sourceSessionNativeId: nativeSessionId,
    nativeType: `message/${row.role ?? 'unknown'}`,
    nativeId,
    sourceSequence: row.row_id * 10,
    occurredAt,
    capturedAt,
    locator: { kind: 'database', path: dbPath, table: 'messages', rowId: String(row.row_id) },
    fingerprint,
    payload: {
      message,
      session: { nativeSessionId, ...(row.cwd ? { cwd: row.cwd } : {}) },
      captureChannel,
    } satisfies HermesDbEnvelope,
    parserVersion: PARSER_VERSION,
  }
}

export async function* ingestHermesHistory(ctx: SourceExecutionContext): AsyncIterable<SourceRecord> {
  const root = ctx.installation.dataRoot
  if (!root || ctx.abortSignal.aborted || !await exists(join(root, DB_NAME))) return
  const db = openDatabase(root)
  try {
    let rowId = await ctx.checkpoint.get<number>('history-rowid') ?? 0
    while (!ctx.abortSignal.aborted) {
      const rows = selectRows(db, rowId, HISTORY_BATCH)
      if (!rows.length) break
      for (const row of rows) {
        if (ctx.abortSignal.aborted) return
        yield dbRecord(row, ctx, 'history')
        rowId = row.row_id
        await ctx.checkpoint.set('history-rowid', rowId)
      }
      if (rows.length < HISTORY_BATCH) break
    }
  } finally {
    db.close()
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
      event: asRecord(sanitize(parsed.event)),
    }
  } catch {
    return {
      id: fileName,
      capturedAt: new Date().toISOString(),
      event: { hook_event_name: 'malformed', raw: truncate(text) },
    }
  }
}

function hookSessionId(event: Record<string, unknown>): string {
  return stringField(event, 'session_id', 'task_id', 'session_key') ?? 'runtime-unknown'
}

function hookCallId(event: Record<string, unknown>): string | undefined {
  const direct = stringField(event, 'tool_call_id', 'call_id', 'tool_use_id')
  if (direct) return direct
  const request = stringField(event, 'api_request_id')
  const count = event.api_call_count
  const tool = stringField(event, 'tool_name')
  if (request && tool) return `${request}:${String(count ?? '')}:${tool}`
  return undefined
}

function hookRecord(envelope: InboxEnvelope, filePath: string, ctx: SourceExecutionContext): SourceRecord {
  const event = envelope.event
  const eventName = stringField(event, 'hook_event_name', 'event_name', 'type') ?? 'unknown'
  const sessionId = hookSessionId(event)
  const callId = hookCallId(event)
  const nativeId = callId ?? stringField(event, 'source_event_id', 'hook_invocation_id', 'turn_id') ?? envelope.id
  const occurredAt = normalizeTimestamp(event.timestamp ?? event.ts) ?? envelope.capturedAt
  const cwd = stringField(event, 'cwd', 'working_directory', 'workdir')
  return {
    id: `hermes-hook-${sha256(envelope.id).slice(0, 32)}`,
    sourceId: SOURCE_ID,
    installationId: ctx.installation.id,
    sourceSessionNativeId: sessionId,
    nativeType: `hook/${eventName}`,
    nativeId,
    occurredAt,
    capturedAt: envelope.capturedAt,
    locator: { kind: 'runtime-hook', path: filePath, hookEventId: envelope.id },
    fingerprint: sha256(JSON.stringify(event)),
    payload: {
      runtimeEvent: event,
      session: { nativeSessionId: sessionId, ...(cwd ? { cwd } : {}) },
      captureChannel: 'runtime-hook',
    } satisfies HermesHookEnvelope,
    parserVersion: PARSER_VERSION,
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
      } catch {
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
      await sleep(INBOX_POLL_MS, ctx.abortSignal)
    }
  })()

  const dbTask = (async () => {
    while (!stopped && !ctx.abortSignal.aborted) {
      await sleep(DB_POLL_MS, ctx.abortSignal)
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

async function* walkSkillFiles(root: string): AsyncIterable<string> {
  let dir
  try { dir = await opendir(root) } catch { return }
  for await (const entry of dir) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* walkSkillFiles(path)
    else if (entry.isFile() && entry.name === 'SKILL.md') yield path
  }
}

function assetEvidence(path: string, observedAt: string): EvidenceCandidate[] {
  return [{
    captureMethod: 'static-scan',
    derivation: 'observed',
    sourceLocator: { kind: 'file', path },
    eventTime: observedAt,
    capturedAt: new Date().toISOString(),
    confidenceHint: 'exact',
  }]
}

function installedState(path: string, observedAt: string): NonNullable<DiscoveredAsset['states']> {
  return [{
    state: 'installed',
    value: true,
    observedAt,
    evidenceCandidates: assetEvidence(path, observedAt),
  }]
}

async function* discoverSkillAssets(root: string): AsyncIterable<DiscoveredAsset> {
  for await (const skillFile of walkSkillFiles(join(root, 'skills'))) {
    const meta = await stat(skillFile).catch(() => null)
    if (!meta) continue
    const relative = skillFile.slice(join(root, 'skills').length + 1).replace(/[\\/]+SKILL\.md$/, '')
    const name = relative.replace(/[\\/]+/g, ':') || basename(dirname(skillFile))
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: { type: 'skill', canonicalName: name, displayName: basename(dirname(skillFile)) },
      binding: { path: skillFile, source: 'hermes:skills' },
      states: installedState(skillFile, observedAt),
    }
  }
}

async function* discoverDirectoryAssets(root: string, directory: string, type: 'plugin' | 'mcp' | 'memory'): AsyncIterable<DiscoveredAsset> {
  const path = join(root, directory)
  let entries
  try { entries = await readdir(path, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (!entry.isDirectory() && type !== 'memory') continue
    const itemPath = join(path, entry.name)
    const meta = await stat(itemPath).catch(() => null)
    if (!meta) continue
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: { type, canonicalName: entry.name, displayName: entry.name },
      binding: { path: itemPath, source: `hermes:${directory}` },
      states: installedState(itemPath, observedAt),
    }
  }
}

function yamlSectionNames(text: string, section: string): string[] {
  const names: string[] = []
  let active = false
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (top && !line.startsWith(' ')) {
      active = top[1] === section
      continue
    }
    if (!active) continue
    const child = line.match(/^\s{2}([A-Za-z0-9_.@/-]+):/)
    if (child) names.push(child[1])
  }
  return names
}

function yamlListValues(text: string, sections: string[]): string[] {
  const wanted = new Set(sections)
  const values: string[] = []
  let active = false
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (top && !line.startsWith(' ')) {
      active = wanted.has(top[1])
      continue
    }
    if (!active) continue
    const item = line.match(/^\s*-\s*["']?([^"'\s#]+)["']?/)
    if (item) values.push(item[1])
  }
  return values
}

async function* discoverConfigAssets(root: string): AsyncIterable<DiscoveredAsset> {
  const configPath = join(root, 'config.yaml')
  if (!await exists(configPath)) return
  const [text, meta] = await Promise.all([readFile(configPath, 'utf8'), stat(configPath)])
  const observedAt = meta.mtime.toISOString()
  for (const name of yamlSectionNames(text, 'mcp_servers')) {
    yield {
      definition: { type: 'mcp', canonicalName: name, displayName: name },
      binding: { path: configPath, source: 'hermes:config' },
      states: [{ state: 'configured', value: true, observedAt, evidenceCandidates: assetEvidence(configPath, observedAt) }],
    }
  }
  for (const name of yamlListValues(text, ['toolsets', 'platform_toolsets'])) {
    yield {
      definition: { type: 'builtin', canonicalName: name, displayName: name },
      binding: { path: configPath, source: 'hermes:config' },
      states: [{ state: 'configured', value: true, observedAt, evidenceCandidates: assetEvidence(configPath, observedAt) }],
    }
  }
}

export async function* discoverHermesAssets(ctx: SourceExecutionContext): AsyncIterable<DiscoveredAsset> {
  const roots = unique([ctx.installation.configRoot ?? '', ctx.installation.dataRoot ?? ''])
  for (const root of roots) {
    for (const group of [
      discoverSkillAssets(root),
      discoverDirectoryAssets(root, 'plugins', 'plugin'),
      discoverDirectoryAssets(root, 'mcp-servers', 'mcp'),
      discoverDirectoryAssets(root, 'memories', 'memory'),
      discoverConfigAssets(root),
    ]) {
      for await (const asset of group) {
        if (ctx.abortSignal.aborted) return
        yield asset
      }
    }
  }
}

function evidenceFor(record: SourceRecord, envelope: HermesEnvelope): EvidenceCandidate {
  const runtime = envelope.captureChannel === 'runtime-hook'
  return {
    captureMethod: runtime ? 'runtime-hook' : 'native-db',
    derivation: runtime ? 'observed' : 'reported',
    sourceRecordId: record.id,
    sourceLocator: record.locator,
    parserVersion: record.parserVersion,
    ...(record.nativeId ? { nativeStableId: record.nativeId } : {}),
    ...(record.occurredAt ? { eventTime: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    confidenceHint: runtime ? 'high' : 'exact',
  }
}

function identity(record: SourceRecord, envelope: HermesEnvelope): ObservationIdentityHints {
  return {
    nativeSessionId: envelope.session.nativeSessionId || record.sourceSessionNativeId || 'unknown',
    ...(envelope.session.cwd ? { workspacePath: envelope.session.cwd } : {}),
  }
}

function candidate(
  record: SourceRecord,
  envelope: HermesEnvelope,
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
  return { ...(callId ? { callId } : {}), toolName, input: sanitize(input) }
}

function contentText(message: Record<string, unknown>): string {
  const raw = message.raw_content
  if (typeof raw === 'string') return truncate(raw)
  const content = message.content
  if (typeof content === 'string') return truncate(content)
  if (content == null) return ''
  return truncate(typeof content === 'object' ? JSON.stringify(content) : String(content))
}

function resultSuccess(content: unknown): boolean | undefined {
  const record = asRecord(content)
  if (typeof record.success === 'boolean') return record.success
  if (typeof record.exit_code === 'number') return record.exit_code === 0
  if (record.error != null) return false
  return undefined
}

function normalizeDbEnvelope(record: SourceRecord, envelope: HermesDbEnvelope): ObservationCandidate[] {
  const message = asRecord(envelope.message)
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
      const callId = parts.callId ?? `hermes-call-${record.id}-${offset}`
      observations.push(candidate(record, envelope, 'tool.call', {
        callId,
        nativeToolName: parts.toolName,
        input: parts.input,
      }, { nativeCallId: callId, offset: offset++ }))
    }
    if (!observations.length) observations.push(candidate(record, envelope, 'message.assistant', { text: '' }))
  } else if (role === 'tool') {
    const callId = stringField(message, 'tool_call_id') ?? `hermes-result-${record.id}`
    const content = message.content
    const success = resultSuccess(content)
    observations.push(candidate(record, envelope, 'tool.result', {
      callId,
      nativeToolName: stringField(message, 'tool_name') ?? 'unknown',
      ...(success === undefined ? {} : { success }),
      output: sanitize(content ?? message.raw_content ?? ''),
    }, { nativeCallId: callId }))
  } else {
    observations.push(candidate(record, envelope, 'unknown', { rawType: `message/${role}`, rawPayload: message }))
  }
  return observations
}

function normalizeHookEnvelope(record: SourceRecord, envelope: HermesHookEnvelope): ObservationCandidate[] {
  const event = asRecord(envelope.runtimeEvent)
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
    const id = callId ?? `hermes-hook-call-${record.id}`
    return [candidate(record, envelope, 'tool.call', {
      callId: id,
      nativeToolName: toolName,
      input: sanitize(event.args ?? event.tool_input ?? {}),
    }, { nativeCallId: id })]
  }
  if (eventName === 'post_tool_call') {
    const id = callId ?? `hermes-hook-call-${record.id}`
    const status = stringField(event, 'status')
    const success = status ? status === 'ok' : resultSuccess(parseJson(typeof event.result === 'string' ? event.result : null))
    return [candidate(record, envelope, 'tool.result', {
      callId: id,
      nativeToolName: toolName,
      ...(success === undefined ? {} : { success }),
      output: sanitize(event.result ?? ''),
      ...(typeof event.duration_ms === 'number' ? { durationMs: event.duration_ms } : {}),
      ...(status ? { status } : {}),
    }, { nativeCallId: id })]
  }
  if (eventName === 'pre_approval_request') {
    return [candidate(record, envelope, 'permission.request', sanitize(event))]
  }
  if (eventName === 'post_approval_response') {
    return [candidate(record, envelope, 'permission.response', sanitize(event))]
  }
  if (eventName === 'subagent_start') return [candidate(record, envelope, 'subagent.spawn', sanitize(event))]
  if (eventName === 'subagent_stop') return [candidate(record, envelope, 'subagent.end', sanitize(event))]
  return [candidate(record, envelope, 'unknown', { rawType: `hook/${eventName}`, rawPayload: event })]
}

export async function normalizeHermesRecord(
  record: SourceRecord,
  _ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  const envelope = record.payload as HermesEnvelope
  const observations = envelope.captureChannel === 'runtime-hook'
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
    { sourceId: SOURCE_ID, name: 'asset-discovery', status: 'available', captureModes: ['static-scan'] },
    { sourceId: SOURCE_ID, name: 'thinking', status: 'unavailable', captureModes: [], reason: 'No stable source-visible reasoning mapping is implemented' },
    { sourceId: SOURCE_ID, name: 'context', status: 'unavailable', captureModes: [], reason: 'Context lifecycle mapping is not implemented' },
    { sourceId: SOURCE_ID, name: 'usage', status: 'unavailable', captureModes: [], reason: 'Usage mapping is not implemented' },
    { sourceId: SOURCE_ID, name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: 'Asset attribution is not implemented' },
    { sourceId: SOURCE_ID, name: 'artifact-action', status: 'unavailable', captureModes: [], reason: 'Artifact attribution is not implemented' },
  ]
}

export const hermesManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-hermes',
  pluginVersion: '1.0.0-alpha.1',
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
  hermesRoots,
  hermesInboxDirectory,
  normalizeTimestamp,
  rowFingerprint,
  parseInboxEnvelope,
  hookRecord,
  yamlSectionNames,
  yamlListValues,
}
