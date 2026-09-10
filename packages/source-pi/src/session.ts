import { createHash } from 'node:crypto'
import { createReadStream, watch, type FSWatcher } from 'node:fs'
import {
  access,
  opendir,
  readFile,
  stat,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import type {
  DetectedSource,
  Disposable,
  SourceDetectionContext,
  SourceExecutionContext,
  SourceHistoryExecutionContext,
  SourceHistoryWindow,
  SourceRecord,
  SourceRecordEmitter,
} from '@agent-lens/core'
import {
  resolveExecutable,
  resolvePiLocation,
} from '@agent-lens/runtime-cordis'

const SOURCE_ID = 'pi'
const PARSER_VERSION = '7'
const RUNTIME_FALLBACK_POLL_MS = 5000
const RUNTIME_RECONCILE_POLL_MS = 60_000
const RUNTIME_DEBOUNCE_MS = 180

interface PiSessionMetadata {
  nativeSessionId: string
  cwd?: string
  version?: string | number
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
  terminated: boolean
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
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

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

async function readPiSettings(configRoot: string): Promise<Record<string, unknown> | null> {
  try {
    return parseJsonObject(await readFile(join(configRoot, 'settings.json'), 'utf8'))
  } catch {
    return null
  }
}

function settingSessionDir(
  raw: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const dataRoot = resolvePiLocation({ ...env, PI_CODING_AGENT_SESSION_DIR: raw }).dataRoot
  // Pi keeps relative sessionDir relative to the invoking process cwd. AgentLens observes
  // sessions outside that invocation and therefore cannot resolve a relative value truthfully.
  // Do not guess a daemon-relative path and accidentally observe the wrong directory.
  return isAbsolute(dataRoot) ? dataRoot : undefined
}

async function resolveDetectedSessionDir(
  env: Readonly<Record<string, string | undefined>>,
  configRoot: string,
  defaultDataRoot: string,
): Promise<string> {
  if (env.PI_CODING_AGENT_SESSION_DIR?.trim()) return defaultDataRoot
  const settings = await readPiSettings(configRoot)
  const configured = settings ? stringField(settings, 'sessionDir')?.trim() : undefined
  return configured ? settingSessionDir(configured, env) ?? defaultDataRoot : defaultDataRoot
}

export function piSessionsDir(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return resolvePiLocation(env).dataRoot
}

export async function detectPi(ctx: SourceDetectionContext): Promise<DetectedSource[]> {
  const env = ctx.env ?? process.env
  const location = resolvePiLocation(env)
  const dataRoot = await resolveDetectedSessionDir(env, location.configRoot, location.dataRoot)
  const [agentExists, sessionsExist, executable] = await Promise.all([
    exists(location.configRoot),
    exists(dataRoot),
    resolveExecutable('pi', {
      explicit: env.PI_BIN,
      pathValue: env.PATH,
    }),
  ])
  if (!agentExists && !sessionsExist && !executable) return []
  return [{
    sourceId: SOURCE_ID,
    productId: SOURCE_ID,
    ...(executable ? { executable } : {}),
    configRoot: location.configRoot,
    dataRoot,
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

export async function listJsonlFiles(root: string, historyWindow?: SourceHistoryWindow): Promise<string[]> {
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

export async function* readJsonlLines(filePath: string, startOffset: number): AsyncIterable<JsonlLine> {
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
        terminated: true,
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
      terminated: false,
    }
  }
}

function parseLine(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { type: 'malformed-json', raw: text, reason: 'Pi JSONL entry is not an object' }
  } catch {
    return { type: 'malformed-json', raw: text }
  }
}

function completeJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

async function readSessionHeader(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    for await (const line of readJsonlLines(filePath, 0)) {
      if (!line.text.trim()) continue
      if (!line.terminated && !completeJson(line.text)) return null
      const entry = parseLine(line.text)
      return entry.type === 'session' ? entry : null
    }
    return null
  } catch {
    return null
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
  const version = header.version
  return {
    nativeSessionId: stringField(header, 'id') ?? fallback,
    ...(stringField(header, 'cwd') ? { cwd: stringField(header, 'cwd') } : {}),
    ...(typeof version === 'string' || typeof version === 'number' ? { version } : {}),
    ...(nativeParentSessionId ? { nativeParentSessionId } : {}),
  }
}

function historyCheckpointKey(filePath: string): string {
  return `pi:history:v5-complete-jsonl:${sha256(filePath)}`
}

function nativeId(entry: Record<string, unknown>, sessionId: string): string | undefined {
  if (entry.type === 'session') return `session:${sessionId}`
  return stringField(entry, 'id')
}

export async function* ingestPiFile(
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

    // A live JSONL file may be observed between two writes. An unterminated fragment that
    // does not yet parse as JSON is not a record: leave the checkpoint before it so the
    // next append reconstructs the original Pi entry instead of persisting two fake rows.
    if (!line.terminated && line.text.trim() && !completeJson(line.text)) break

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
  let reconcileTimer: NodeJS.Timeout | null = null
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

  const poll = async (historyWindow?: SourceHistoryWindow) => {
    if (stopped || ctx.abortSignal.aborted) return
    for (const filePath of await listJsonlFiles(sessionsDir, historyWindow)) schedule(filePath)
  }

  const scheduleReconcile = () => {
    if (stopped) return
    if (reconcileTimer) clearTimeout(reconcileTimer)
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null
      void poll().catch(() => undefined)
    }, RUNTIME_DEBOUNCE_MS)
  }

  const startPolling = (intervalMs: number) => {
    if (pollTimer) clearInterval(pollTimer)
    if (stopped) return
    pollTimer = setInterval(() => { void poll().catch(() => undefined) }, intervalMs)
  }

  try {
    watcher = watch(sessionsDir, { recursive: true }, (_event, fileName) => {
      if (!fileName) {
        scheduleReconcile()
        return
      }
      const path = join(sessionsDir, fileName.toString())
      if (extname(path).toLowerCase() === '.jsonl') schedule(path)
      else scheduleReconcile()
    })
    watcher.on('error', () => {
      watcher?.close()
      watcher = null
      startPolling(RUNTIME_FALLBACK_POLL_MS)
    })
    // Native watchers can silently miss events on some filesystems. A low-frequency full
    // reconciliation preserves eventual completeness without turning polling into the hot path.
    startPolling(RUNTIME_RECONCILE_POLL_MS)
  } catch {
    watcher = null
    startPolling(RUNTIME_FALLBACK_POLL_MS)
  }

  // watcher only covers future changes. Reconcile the newest existing session once so a
  // session created just before daemon startup does not need another write to become visible.
  void poll({ sessionLimit: 1 }).catch(() => undefined)

  return {
    async dispose(): Promise<void> {
      if (stopped) return
      stopped = true
      watcher?.close()
      if (pollTimer) clearInterval(pollTimer)
      if (reconcileTimer) clearTimeout(reconcileTimer)
      for (const timer of debounce.values()) clearTimeout(timer)
      debounce.clear()
      await processing
    },
  }
}

export const piSessionInternals = {
  listJsonlFiles,
  piSessionsDir,
  readJsonlLines,
  ingestPiFile,
  readSessionHeader,
  resolveDetectedSessionDir,
}
