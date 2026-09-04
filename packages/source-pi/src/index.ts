import { createHash } from 'node:crypto'
import { createReadStream, watch, type FSWatcher } from 'node:fs'
import {
  access,
  open,
  opendir,
  readFile,
  readdir,
  stat,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
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
  SourceHistoryExecutionContext,
  SourceHistoryWindow,
  SourceNormalizationContext,
  SourcePluginManifest,
  SourceRecord,
  SourceRecordEmitter,
} from '@agent-lens/core'
import {
  defineAgentLensPlugin,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import { normalizePiSessionEntry, type PiNativeFact } from '@agent-lens/protocol'

const SOURCE_ID = 'pi'
const PARSER_VERSION = '5'
const RUNTIME_FALLBACK_POLL_MS = 5000
const RUNTIME_DEBOUNCE_MS = 180
const MAX_STRING = 64 * 1024
const SESSION_HEADER_BYTES = 64 * 1024

interface PiSessionMetadata {
  nativeSessionId: string
  cwd?: string | undefined
  version?: string | undefined
  nativeParentSessionId?: string
}

interface PiStoredEnvelope {
  entry: Record<string, unknown>
  session: PiSessionMetadata
}

interface HistoryCheckpoint {
  path: string
  offset: number
  sequence: number
  size: number
  mtimeMs: number
}

interface JsonlLine {
  text: string
  startOffset: number
  endOffset: number
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function truncate(value: string, limit = MAX_STRING): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value !== 'string' || !value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findExecutable(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const explicit = env.PI_BIN?.trim()
  if (explicit && await exists(explicit)) return explicit
  const pathValue = env.PATH ?? process.env.PATH ?? ''
  const names = process.platform === 'win32' ? ['pi.exe', 'pi.cmd', 'pi.bat'] : ['pi']
  for (const root of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(root, name)
      if (await exists(candidate)) return candidate
    }
  }
  return undefined
}

function piAgentDir(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env.PI_CODING_AGENT_DIR?.trim()
  if (explicit) return explicit
  const piHome = env.PI_HOME?.trim() || join(homedir(), '.pi')
  return join(piHome, 'agent')
}

export async function detectPi(ctx: SourceDetectionContext): Promise<DetectedSource[]> {
  const env = ctx.env ?? process.env
  const agentDir = piAgentDir(env)
  const sessionsDir = join(agentDir, 'sessions')
  const [agentExists, sessionsExist, executable] = await Promise.all([
    exists(agentDir),
    exists(sessionsDir),
    findExecutable(env),
  ])
  if (!agentExists && !sessionsExist && !executable) return []
  return [{
    sourceId: SOURCE_ID,
    productId: SOURCE_ID,
    ...(executable ? { executable } : {}),
    configRoot: agentDir,
    dataRoot: sessionsDir,
    confidence: executable && sessionsExist ? 'exact' : 'high',
  }]
}

async function* walkJsonlFiles(root: string): AsyncIterable<string> {
  let directory
  try {
    directory = await opendir(root)
  } catch {
    return
  }
  for await (const entry of directory) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* walkJsonlFiles(path)
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.jsonl') yield path
  }
}

async function listJsonlFiles(root: string, historyWindow?: SourceHistoryWindow): Promise<string[]> {
  const paths: string[] = []
  for await (const file of walkJsonlFiles(root)) paths.push(file)
  const candidates = (await Promise.all(paths.map(async path => {
    try {
      return { path, mtimeMs: (await stat(path)).mtimeMs }
    } catch {
      return null
    }
  }))).filter((candidate): candidate is { path: string; mtimeMs: number } => candidate !== null)

  const activeSince = historyWindow?.activeSince ? Date.parse(historyWindow.activeSince) : Number.NaN
  const filtered = Number.isFinite(activeSince)
    ? candidates.filter(candidate => candidate.mtimeMs >= activeSince)
    : candidates
  const ordered = filtered.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path))
  const limit = historyWindow?.sessionLimit
  return (limit === undefined ? ordered : ordered.slice(0, Math.max(0, Math.floor(limit))))
    .map(candidate => candidate.path)
}

async function* readJsonlLines(filePath: string, startOffset: number): AsyncIterable<JsonlLine> {
  const stream = createReadStream(filePath, { start: startOffset })
  let carry = Buffer.alloc(0)
  let carryOffset = startOffset
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
    const dataOffset = carryOffset
    let cursor = 0
    while (true) {
      const newline = data.indexOf(0x0a, cursor)
      if (newline < 0) break
      let line = data.subarray(cursor, newline)
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1)
      yield {
        text: line.toString('utf8'),
        startOffset: dataOffset + cursor,
        endOffset: dataOffset + newline + 1,
      }
      cursor = newline + 1
    }
    carry = data.subarray(cursor)
    carryOffset = dataOffset + cursor
  }
  if (carry.length) {
    yield {
      text: carry.toString('utf8'),
      startOffset: carryOffset,
      endOffset: carryOffset + carry.length,
    }
  }
}

async function readSessionHeader(filePath: string): Promise<Record<string, unknown> | null> {
  let handle
  try {
    handle = await open(filePath, 'r')
    const buffer = Buffer.alloc(SESSION_HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const preview = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = preview.search(/\r?\n/)
    const first = newline >= 0 ? preview.slice(0, newline) : preview
    if (!first) return null
    const entry = asRecord(JSON.parse(first))
    return entry.type === 'session' ? entry : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function sessionMetadata(filePath: string): Promise<PiSessionMetadata> {
  const header = await readSessionHeader(filePath)
  const fallback = basename(filePath, extname(filePath))
  if (!header) return { nativeSessionId: fallback }
  const parentSession = stringField(header, 'parentSession')
  let nativeParentSessionId: string | undefined
  if (parentSession) {
    const parentPath = isAbsolute(parentSession)
      ? parentSession
      : resolve(dirname(filePath), parentSession)
    nativeParentSessionId = stringField(await readSessionHeader(parentPath) ?? {}, 'id')
  }
  return {
    nativeSessionId: stringField(header, 'id') ?? fallback,
    ...(stringField(header, 'cwd') ? { cwd: stringField(header, 'cwd') } : {}),
    ...(stringField(header, 'version') ? { version: stringField(header, 'version') } : {}),
    ...(nativeParentSessionId ? { nativeParentSessionId } : {}),
  }
}

function historyCheckpointKey(filePath: string): string {
  return `pi:history:v4-entry-tree:${sha256(filePath)}`
}

function parseLine(text: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return { type: 'malformed-json', raw: text }
  }
}

function nativeId(entry: Record<string, unknown>, sessionId: string): string | undefined {
  if (entry.type === 'session') return `session:${sessionId}`
  return stringField(entry, 'id')
}

async function* ingestPiFile(
  ctx: SourceExecutionContext,
  filePath: string,
): AsyncIterable<SourceRecord> {
  if (ctx.abortSignal.aborted || extname(filePath).toLowerCase() !== '.jsonl') return
  let fileStat
  try { fileStat = await stat(filePath) } catch { return }
  const key = historyCheckpointKey(filePath)
  const previous = await ctx.checkpoint.get<HistoryCheckpoint>(key)
  const unchanged = previous
    && previous.path === filePath
    && previous.offset === fileStat.size
    && previous.size === fileStat.size
    && previous.mtimeMs === fileStat.mtimeMs
  if (unchanged) return

  const reset = !previous || previous.path !== filePath || fileStat.size < previous.offset
  let offset = reset ? 0 : previous.offset
  let sequence = reset ? 0 : previous.sequence
  const session = await sessionMetadata(filePath)

  for await (const line of readJsonlLines(filePath, offset)) {
    if (ctx.abortSignal.aborted) return
    sequence += 1
    offset = line.endOffset
    if (!line.text.trim()) {
      await ctx.checkpoint.set(key, {
        path: filePath, offset, sequence, size: fileStat.size, mtimeMs: fileStat.mtimeMs,
      })
      continue
    }
    const entry = parseLine(line.text)
    const fingerprint = sha256(line.text)
    const entryId = nativeId(entry, session.nativeSessionId)
    const timestamp = normalizeTimestamp(entry.timestamp)
      ?? normalizeTimestamp(asRecord(entry.message).timestamp)
    yield {
      id: `pi-record-${sha256(`${filePath}|${line.startOffset}|${fingerprint}`).slice(0, 32)}`,
      sourceId: SOURCE_ID,
      installationId: ctx.installation.id,
      sourceSessionNativeId: session.nativeSessionId,
      nativeType: `history/${stringField(entry, 'type') ?? 'unknown'}`,
      ...(entryId ? { nativeId: entryId } : {}),
      sourceSequence: sequence * 1000,
      ...(timestamp ? { occurredAt: timestamp } : {}),
      capturedAt: new Date().toISOString(),
      locator: { kind: 'file', path: filePath, offset: line.startOffset },
      fingerprint,
      payload: { entry, session } satisfies PiStoredEnvelope,
      parserVersion: PARSER_VERSION,
    }
    await ctx.checkpoint.set(key, {
      path: filePath, offset, sequence, size: fileStat.size, mtimeMs: fileStat.mtimeMs,
    })
  }
}

export async function* ingestPiHistory(ctx: SourceHistoryExecutionContext): AsyncIterable<SourceRecord> {
  const sessionsDir = ctx.installation.dataRoot
    ?? (ctx.installation.configRoot ? join(ctx.installation.configRoot, 'sessions') : undefined)
  if (!sessionsDir) return
  for (const filePath of await listJsonlFiles(sessionsDir, ctx.historyWindow)) {
    if (ctx.abortSignal.aborted) return
    yield* ingestPiFile(ctx, filePath)
  }
}

export async function startPiRuntimeCapture(
  ctx: SourceExecutionContext,
  emitter: SourceRecordEmitter,
): Promise<Disposable> {
  const sessionsDir = ctx.installation.dataRoot
    ?? (ctx.installation.configRoot ? join(ctx.installation.configRoot, 'sessions') : undefined)
  if (!sessionsDir || !await exists(sessionsDir)) return { dispose() {} }

  let stopped = false
  let watcher: FSWatcher | null = null
  let pollTimer: NodeJS.Timeout | null = null
  const debounce = new Map<string, NodeJS.Timeout>()
  let processing = Promise.resolve()

  const emitFile = (filePath: string) => {
    processing = processing.then(async () => {
      for await (const record of ingestPiFile(ctx, filePath)) {
        if (stopped || ctx.abortSignal.aborted) return
        await emitter.emit(record)
      }
    }).catch(() => undefined)
  }

  const schedule = (filePath: string) => {
    if (stopped || extname(filePath).toLowerCase() !== '.jsonl') return
    const previous = debounce.get(filePath)
    if (previous) clearTimeout(previous)
    debounce.set(filePath, setTimeout(() => {
      debounce.delete(filePath)
      emitFile(filePath)
    }, RUNTIME_DEBOUNCE_MS))
  }

  const poll = async () => {
    if (stopped || ctx.abortSignal.aborted) return
    for (const filePath of await listJsonlFiles(sessionsDir)) schedule(filePath)
  }

  const startFallbackPolling = () => {
    if (pollTimer || stopped) return
    pollTimer = setInterval(() => { void poll().catch(() => undefined) }, RUNTIME_FALLBACK_POLL_MS)
  }

  try {
    watcher = watch(sessionsDir, { recursive: true }, (_event, fileName) => {
      if (!fileName) return
      schedule(join(sessionsDir, fileName.toString()))
    })
    watcher.on('error', () => {
      watcher?.close()
      watcher = null
      startFallbackPolling()
    })
  } catch {
    watcher = null
    startFallbackPolling()
  }

  return {
    async dispose(): Promise<void> {
      if (stopped) return
      stopped = true
      watcher?.close()
      if (pollTimer) clearInterval(pollTimer)
      for (const timer of debounce.values()) clearTimeout(timer)
      debounce.clear()
      await processing
    },
  }
}

async function safeStat(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

async function safeEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

async function* walkNamedFile(
  root: string,
  fileName: string,
  depth = 0,
  maxDepth = 8,
): AsyncIterable<string> {
  if (depth > maxDepth) return
  for (const entry of await safeEntries(root)) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* walkNamedFile(path, fileName, depth + 1, maxDepth)
    else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) yield path
  }
}

function staticEvidence(
  path: string,
  observedAt: string,
  capturedAt: string,
  nativeStableId: string,
): EvidenceCandidate {
  return {
    captureMethod: 'static-scan',
    derivation: 'observed',
    sourceLocator: { kind: 'file', path },
    nativeStableId,
    eventTime: observedAt,
    capturedAt,
    confidenceHint: 'exact',
  }
}

function assetStates(
  path: string,
  observedAt: string,
  capturedAt: string,
  nativeStableId: string,
  values: Array<{
    state: 'installed' | 'configured' | 'enabled' | 'discoverable'
    value: boolean | 'unknown'
  }>,
): NonNullable<DiscoveredAsset['states']> {
  const evidence = staticEvidence(path, observedAt, capturedAt, nativeStableId)
  return values.map(value => ({ ...value, observedAt, evidenceCandidates: [evidence] }))
}

async function* discoverPiSkills(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  for await (const skillFile of walkNamedFile(join(configRoot, 'skills'), 'SKILL.md')) {
    const meta = await safeStat(skillFile)
    if (!meta?.isFile()) continue
    const dir = dirname(skillFile)
    const name = basename(dir)
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: { type: 'skill', canonicalName: name, displayName: name },
      binding: { path: dir, source: 'pi:skills' },
      states: assetStates(
        skillFile,
        observedAt,
        capturedAt,
        `skill:${skillFile}`,
        [
          { state: 'installed', value: true },
          { state: 'discoverable', value: true },
        ],
      ),
    }
  }
}

async function* discoverPiExtensions(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const root = join(configRoot, 'extensions')
  for (const entry of await safeEntries(root)) {
    const path = join(root, entry.name)
    if (!entry.isDirectory() && !entry.isFile()) continue
    const meta = await safeStat(path)
    if (!meta) continue
    const name = entry.isFile() ? basename(entry.name, extname(entry.name)) : entry.name
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: { type: 'extension', canonicalName: name, displayName: name },
      binding: { path, source: 'pi:extensions' },
      states: assetStates(
        path,
        observedAt,
        capturedAt,
        `extension:${path}`,
        [
          { state: 'installed', value: true },
          { state: 'enabled', value: true },
        ],
      ),
    }
  }
}

async function* discoverPiMemory(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  for (const name of ['pi-hermes-memory', 'projects-memory']) {
    const path = join(configRoot, name)
    const meta = await safeStat(path)
    if (!meta) continue
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: { type: 'memory', canonicalName: name, displayName: name },
      binding: { path, source: 'pi:memory' },
      states: assetStates(
        path,
        observedAt,
        capturedAt,
        `memory:${path}`,
        [{ state: 'installed', value: true }],
      ),
    }
  }
}

async function* discoverPiSettings(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const settingsPath = join(configRoot, 'settings.json')
  const meta = await safeStat(settingsPath)
  if (!meta?.isFile()) return
  let settings: Record<string, unknown>
  try {
    settings = asRecord(JSON.parse(await readFile(settingsPath, 'utf8')))
  } catch {
    return
  }
  const observedAt = meta.mtime.toISOString()
  const mcp = asRecord(settings.mcpServers ?? settings.mcp_servers)
  for (const name of Object.keys(mcp)) {
    yield {
      definition: { type: 'mcp', canonicalName: name, displayName: name },
      binding: { path: settingsPath, source: 'pi:settings' },
      states: assetStates(
        settingsPath,
        observedAt,
        capturedAt,
        `mcp:${settingsPath}:${name}`,
        [
          { state: 'configured', value: true },
          { state: 'discoverable', value: true },
        ],
      ),
    }
  }
}

export async function* discoverPiAssets(
  ctx: SourceExecutionContext,
): AsyncIterable<DiscoveredAsset> {
  const root = ctx.installation.configRoot
  if (!root || ctx.abortSignal.aborted) return
  const capturedAt = new Date().toISOString()
  for (const group of [
    discoverPiSkills(root, capturedAt),
    discoverPiExtensions(root, capturedAt),
    discoverPiMemory(root, capturedAt),
    discoverPiSettings(root, capturedAt),
  ]) {
    for await (const asset of group) {
      if (ctx.abortSignal.aborted) return
      yield asset
    }
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (typeof block === 'string') return block
    const item = asRecord(block)
    return item.type === 'text' ? stringField(item, 'text') ?? '' : ''
  }).filter(Boolean).join('\n\n')
}

function evidenceFor(record: SourceRecord): EvidenceCandidate {
  return {
    captureMethod: 'native-log',
    derivation: 'reported',
    sourceRecordId: record.id,
    sourceLocator: record.locator,
    parserVersion: record.parserVersion,
    ...(record.nativeId ? { nativeStableId: record.nativeId } : {}),
    ...(record.occurredAt ? { eventTime: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    confidenceHint: record.nativeId ? 'exact' : 'high',
  }
}

function baseIdentity(
  record: SourceRecord,
  envelope: PiStoredEnvelope,
): ObservationIdentityHints {
  return {
    nativeSessionId: envelope.session.nativeSessionId || record.sourceSessionNativeId || 'unknown',
    ...(envelope.session.nativeParentSessionId
      ? { nativeParentSessionId: envelope.session.nativeParentSessionId }
      : {}),
    ...(envelope.session.cwd ? { workspacePath: envelope.session.cwd } : {}),
  }
}

function candidate(
  record: SourceRecord,
  envelope: PiStoredEnvelope,
  kind: ObservationCandidate['kind'],
  payload: unknown,
  options: {
    nativeCallId?: string | undefined
    nativeEventId?: string | undefined
    nativeParentEventId?: string | undefined
    sequenceOffset?: number
    identity?: Partial<ObservationIdentityHints>
  } = {},
): ObservationCandidate {
  const nativeCallId = options.nativeCallId
  const eventId = options.nativeEventId ?? record.nativeId
  const sourceSequence = record.sourceSequence === undefined
    ? undefined
    : record.sourceSequence + (options.sequenceOffset ?? 0)
  const nativeParentEventId = options.nativeParentEventId ?? stringField(envelope.entry, 'parentId')
  return {
    kind,
    ...(eventId ? { nativeEventId: eventId } : {}),
    ...(nativeParentEventId ? { nativeParentEventId } : {}),
    ...(nativeCallId ? { nativeCallId } : {}),
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
    ...(record.occurredAt ? { occurredAt: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    payload,
    identityHints: { ...baseIdentity(record, envelope), ...(options.identity ?? {}) },
    dedupHints: {
      ...(eventId ? { nativeEventId: eventId } : {}),
      ...(nativeCallId ? { nativeCallId } : {}),
      ...(sourceSequence === undefined ? {} : { sourceSequence }),
      ...(record.fingerprint ? { payloadFingerprint: record.fingerprint } : {}),
    },
  }
}

function piFactCandidate(
  record: SourceRecord,
  envelope: PiStoredEnvelope,
  fact: PiNativeFact,
  kind: ObservationCandidate['kind'],
  payload: unknown,
  sequenceOffset: number,
  options: { nativeCallId?: string; identity?: Partial<ObservationIdentityHints> } = {},
): ObservationCandidate {
  return candidate(record, envelope, kind, payload, {
    nativeEventId: fact.id,
    nativeParentEventId: fact.parentId,
    ...(options.nativeCallId ? { nativeCallId: options.nativeCallId } : {}),
    sequenceOffset,
    ...(options.identity ? { identity: options.identity } : {}),
  })
}

export async function normalizePiRecord(
  record: SourceRecord,
  _ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  const envelope = asRecord(record.payload) as unknown as PiStoredEnvelope
  const entry = asRecord(envelope.entry)
  const facts = normalizePiSessionEntry(entry, {
    ...(record.nativeId ? { nativeEventId: record.nativeId } : {}),
    fallbackId: record.id,
  })
  const observations: ObservationCandidate[] = []

  facts.forEach((fact, index) => {
    const offset = index + 1
    if (fact.kind === 'message') {
      if (fact.role === 'user') {
        observations.push(piFactCandidate(record, envelope, fact, 'message.user', {
          text: truncate(fact.text),
          ...(fact.nonTextContent.length ? { nonTextContent: fact.nonTextContent } : {}),
        }, offset))
        return
      }
      if (fact.role === 'assistant') {
        observations.push(piFactCandidate(record, envelope, fact, 'message.assistant', {
          text: truncate(fact.text),
          ...(fact.content === undefined ? {} : { content: fact.content }),
          ...(fact.nonTextContent.length ? { nonTextContent: fact.nonTextContent } : {}),
          ...(fact.model ? { model: fact.model } : {}),
          ...(fact.provider ? { provider: fact.provider } : {}),
          ...(fact.stopReason ? { stopReason: fact.stopReason } : {}),
          ...(fact.errorMessage ? { errorMessage: fact.errorMessage } : {}),
        }, offset, { identity: fact.model ? { modelName: fact.model } : {} }))
        return
      }
      observations.push(piFactCandidate(record, envelope, fact, 'unknown', {
        rawType: `message/${fact.role}`,
        rawPayload: fact.raw,
      }, offset))
      return
    }
    if (fact.kind === 'thinking') {
      observations.push(piFactCandidate(record, envelope, fact, 'message.reasoning', { text: truncate(fact.text) }, offset))
      return
    }
    if (fact.kind === 'tool-call') {
      observations.push(piFactCandidate(record, envelope, fact, 'tool.call', {
        callId: fact.callId,
        nativeToolName: fact.name,
        input: fact.input,
      }, offset, { nativeCallId: fact.callId }))
      return
    }
    if (fact.kind === 'tool-result') {
      observations.push(piFactCandidate(record, envelope, fact, 'tool.result', {
        callId: fact.callId,
        nativeToolName: fact.name,
        success: fact.success,
        output: truncate(fact.output),
        ...(fact.details === undefined ? {} : { details: fact.details }),
      }, offset, { nativeCallId: fact.callId }))
      return
    }
    if (fact.kind === 'usage') {
      observations.push(piFactCandidate(record, envelope, fact, 'usage', fact.usage, offset))
      return
    }
    if (fact.kind === 'event') {
      const kind: ObservationCandidate['kind'] = fact.event === 'model.changed'
        ? 'model.changed'
        : fact.event === 'thinking.level.changed'
          ? 'thinking.level.changed'
          : fact.event === 'context.compaction'
            ? 'context.compaction'
            : fact.event === 'context.summary'
              ? 'context.summary'
              : fact.event === 'session.started' || fact.event === 'session.info'
                ? 'session.lifecycle'
                : 'unknown'
      const name = fact.event === 'session.info' ? stringField(asRecord(fact.payload), 'name')?.trim() : undefined
      const payload = kind === 'unknown'
        ? { event: fact.event, label: fact.label, detail: fact.detail, rawPayload: fact.payload }
        : kind === 'session.lifecycle'
          ? { event: fact.event, ...asRecord(fact.payload) }
          : fact.payload
      observations.push(piFactCandidate(
        record,
        envelope,
        fact,
        kind,
        payload,
        offset,
        { ...(name ? { identity: { sessionTitle: name } } : {}) },
      ))
      return
    }
    observations.push(piFactCandidate(record, envelope, fact, 'unknown', {
      rawType: fact.nativeType,
      rawPayload: fact.payload,
    }, offset))
  })

  return { observations, evidenceCandidates: [evidenceFor(record)] }
}

export async function declarePiCapabilities(
  _detected: DetectedSource,
): Promise<ObservationCapability[]> {
  return [
    { sourceId: SOURCE_ID, name: 'session', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'transcript', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'tool-call', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'tool-result', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'context', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'model-change', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'thinking-level-change', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'asset-discovery', status: 'available', captureModes: ['static-scan'] },
    { sourceId: SOURCE_ID, name: 'permission', status: 'unavailable', captureModes: [], reason: 'No stable permission event is proven in the native session log' },
    { sourceId: SOURCE_ID, name: 'subagent', status: 'partial', captureModes: ['history'], reason: 'Parent session links are retained; explicit subagent lifecycle is not proven' },
    { sourceId: SOURCE_ID, name: 'thinking', status: 'partial', captureModes: ['history'], reason: 'Only source-visible thinking blocks are captured' },
    { sourceId: SOURCE_ID, name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: 'Invocation attribution is handled by later usage projections' },
    { sourceId: SOURCE_ID, name: 'usage', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'artifact-action', status: 'unavailable', captureModes: [], reason: 'Artifact attribution is not implemented' },
  ]
}

export const piManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-pi',
  pluginVersion: '1.0.0-alpha.2',
  apiVersion: '1.0',
  pluginType: 'source',
  displayName: 'Pi Source',
  sourceId: SOURCE_ID,
  productId: SOURCE_ID,
  parserVersion: PARSER_VERSION,
}

export const piSourceDefinition: SourceDefinition = {
  manifest: piManifest,
  detect: detectPi,
  declareCapabilities: declarePiCapabilities,
  discoverAssets: discoverPiAssets,
  ingestHistory: ingestPiHistory,
  startCapture: startPiRuntimeCapture,
  normalize: normalizePiRecord,
}

const applyPiSource = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.sources.register(piSourceDefinition)
    return () => registration.dispose()
  },
  { inject: ['sources'] },
)

export const piSourcePlugin = defineAgentLensPlugin(piManifest, applyPiSource)

export const piInternals = {
  listJsonlFiles,
}
