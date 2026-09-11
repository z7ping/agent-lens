import { createHash } from 'node:crypto'
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
  discoverInstalledPiSdk,
  resolveExecutable,
  resolvePiLocation,
} from '@agent-lens/runtime-cordis'
import {
  isCompleteJson,
  isMissingPathError,
  readJsonlLines,
  sourceFileIdentity,
  startHistoryFileWatch,
} from '@agent-lens/source-support'
import { PI_PARSER_VERSION, PI_SOURCE_ID } from './constants'

const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024

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
  fileId?: string
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
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
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
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
}

function provenAbsolutePath(path: string): string | undefined {
  return isAbsolute(path) ? path : undefined
}

function settingSessionDir(
  raw: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const dataRoot = resolvePiLocation({ ...env, PI_CODING_AGENT_SESSION_DIR: raw }).dataRoot
  // Pi keeps relative session directories relative to the invoking process cwd. AgentLens is
  // observing an installation outside that invocation, so a daemon-relative resolution would
  // be a fabricated location rather than a Pi fact.
  return provenAbsolutePath(dataRoot)
}

async function resolveDetectedSessionDir(
  env: Readonly<Record<string, string | undefined>>,
  configRoot: string | undefined,
  defaultDataRoot: string,
): Promise<string | undefined> {
  const explicit = env.PI_CODING_AGENT_SESSION_DIR?.trim()
  if (explicit) return settingSessionDir(explicit, env)

  if (configRoot) {
    const settings = await readPiSettings(configRoot)
    const configured = settings ? stringField(settings, 'sessionDir')?.trim() : undefined
    if (configured) return settingSessionDir(configured, env)
  }

  return provenAbsolutePath(defaultDataRoot)
}

export function piSessionsDir(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return provenAbsolutePath(resolvePiLocation(env).dataRoot)
}

async function installedPiVersion(executable: string | undefined): Promise<string | undefined> {
  if (!executable) return undefined
  try {
    return (await discoverInstalledPiSdk(executable)).version
  } catch {
    return undefined
  }
}

export async function detectPi(ctx: SourceDetectionContext): Promise<DetectedSource[]> {
  const env = ctx.env ?? process.env
  const location = resolvePiLocation(env)
  const configRoot = provenAbsolutePath(location.configRoot)
  const dataRoot = await resolveDetectedSessionDir(env, configRoot, location.dataRoot)
  const [agentExists, sessionsExist, executable] = await Promise.all([
    configRoot ? exists(configRoot) : Promise.resolve(false),
    dataRoot ? exists(dataRoot) : Promise.resolve(false),
    resolveExecutable('pi', {
      explicit: env.PI_BIN,
      pathValue: env.PATH,
    }),
  ])
  if (!agentExists && !sessionsExist && !executable) return []
  const version = await installedPiVersion(executable)
  return [{
    sourceId: PI_SOURCE_ID,
    productId: PI_SOURCE_ID,
    ...(executable ? { executable } : {}),
    ...(version ? { version } : {}),
    ...(configRoot ? { configRoot } : {}),
    ...(dataRoot ? { dataRoot } : {}),
    confidence: executable && sessionsExist ? 'exact' : 'high',
  }]
}

async function* walkJsonlFiles(root: string): AsyncIterable<string> {
  let directory
  try {
    directory = await opendir(root)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
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
    } catch (error) {
      if (isMissingPathError(error)) return null
      throw error
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

async function readSessionHeader(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    for await (const line of readJsonlLines(filePath, 0)) {
      if (line.endOffset > MAX_SESSION_HEADER_SCAN_BYTES) return null
      if (!line.text.trim()) continue
      if (!line.terminated && !isCompleteJson(line.text)) return null
      const entry = parseLine(line.text)
      if (entry.type === 'malformed-json') {
        if (line.terminated) continue
        return null
      }
      return entry.type === 'session' && typeof entry.id === 'string' ? entry : null
    }
    return null
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
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
  // Keep the existing checkpoint generation stable. Parser upgrades must not turn the low-frequency
  // runtime reconciliation into an accidental full-history re-ingest on large installations.
  return `pi:history:v6-file-identity:${sha256(filePath)}`
}

function nativeId(entry: Record<string, unknown>): string | undefined {
  return stringField(entry, 'id')
}

export async function* ingestPiFile(
  ctx: SourceExecutionContext,
  filePath: string,
): AsyncIterable<SourceRecord> {
  if (ctx.abortSignal.aborted || extname(filePath).toLowerCase() !== '.jsonl') return
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  const initialFileId = sourceFileIdentity(fileStat)
  const key = historyCheckpointKey(filePath)
  const previous = await ctx.checkpoint.get<HistoryCheckpoint>(key)
  const unchanged = previous
    && previous.path === filePath
    && previous.fileId === initialFileId
    && previous.offset === fileStat.size
    && previous.size === fileStat.size
    && previous.mtimeMs === fileStat.mtimeMs
  if (unchanged) return

  const reset = !previous
    || previous.path !== filePath
    || previous.fileId !== initialFileId
    || fileStat.size < previous.offset
  let offset = reset ? 0 : previous.offset
  let sequence = reset ? 0 : previous.sequence
  let incompleteTail = false
  const session = await sessionMetadata(filePath)

  for await (const line of readJsonlLines(filePath, offset)) {
    if (ctx.abortSignal.aborted) return

    // A live JSONL file may be observed between two writes. An unterminated fragment that
    // does not yet parse as JSON is not a record: leave the checkpoint before it so the
    // next append reconstructs the original Pi entry instead of persisting two fake rows.
    if (!line.terminated && line.text.trim() && !isCompleteJson(line.text)) {
      incompleteTail = true
      break
    }

    sequence += 1
    offset = line.endOffset
    if (!line.text.trim()) {
      await ctx.checkpoint.set(key, {
        path: filePath,
        offset,
        sequence,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        fileId: initialFileId,
      })
      continue
    }

    const entry = parseLine(line.text)
    const fingerprint = sha256(line.text)
    const entryId = nativeId(entry)
    const timestamp = normalizeTimestamp(entry.timestamp)
      ?? normalizeTimestamp(asRecord(entry.message).timestamp)
    yield {
      id: `pi-record-${sha256(`${filePath}|${line.startOffset}|${fingerprint}`).slice(0, 32)}`,
      sourceId: PI_SOURCE_ID,
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
      parserVersion: PI_PARSER_VERSION,
    }
    await ctx.checkpoint.set(key, {
      path: filePath,
      offset,
      sequence,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      fileId: initialFileId,
    })
  }

  // If the stream reached a complete EOF, reconcile metadata after the read. The file can grow
  // while we are consuming it; keeping the initial size/mtime would make every later poll think
  // the file changed even when the checkpoint already sits at the real EOF. If the path was
  // replaced during the read, keep the old file identity so the next pass resets the new file.
  if (!ctx.abortSignal.aborted && !incompleteTail) {
    try {
      const finalStat = await stat(filePath)
      if (sourceFileIdentity(finalStat) === initialFileId) {
        await ctx.checkpoint.set(key, {
          path: filePath,
          offset,
          sequence,
          size: finalStat.size,
          mtimeMs: finalStat.mtimeMs,
          fileId: initialFileId,
        })
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      // A removed/rotated file will be rediscovered or reset on the next scan.
    }
  }
}

export async function* ingestPiHistory(ctx: SourceHistoryExecutionContext): AsyncIterable<SourceRecord> {
  const sessionsDir = ctx.installation.dataRoot
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
  if (!sessionsDir || !await exists(sessionsDir)) return { dispose() {} }

  return startHistoryFileWatch({
    root: sessionsDir,
    signal: ctx.abortSignal,
    accept: filePath => extname(filePath).toLowerCase() === '.jsonl',
    listFiles: limit => listJsonlFiles(
      sessionsDir,
      limit === undefined ? undefined : { sessionLimit: limit },
    ),
    onFile: async filePath => {
      for await (const record of ingestPiFile(ctx, filePath)) {
        if (ctx.abortSignal.aborted) return
        await emitter.emit(record)
      }
    },
    debounceMs: 180,
    fallbackPollMs: 5_000,
    fallbackReconcileLimit: 20,
    reconcilePollMs: 60_000,
    reconcileLimit: 20,
    initialReconcileLimit: 1,
    onError: error => {
      console.error('[AgentLens] Pi history reconcile failed', error)
    },
  })
}

export const piSessionInternals = {
  listJsonlFiles,
  piSessionsDir,
  readJsonlLines,
  ingestPiFile,
  readSessionHeader,
  resolveDetectedSessionDir,
}
