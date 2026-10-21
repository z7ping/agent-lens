import { createHash } from 'node:crypto'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SourceExecutionContext, SourceHistoryExecutionContext, SourceHistoryWindow, SourceRecord } from '@agent-lens/core'
import { asRecord, isCompleteJson, isMissingPathError, readJsonlLines, sourceFileIdentity, type JsonlLine } from '@agent-lens/source-support'
import {
  nativeIdForEntry,
  nativeTypeForEntry,
  type CodexSessionMetadata,
  type CodexStoredEnvelope,
} from './format'

interface HistoryCheckpoint {
  path: string
  offset: number
  sequence: number
  size: number
  mtimeMs: number
  fileId?: string
  parserVersion?: string
}

interface MetadataCheckpoint {
  startFingerprint?: string
  titleFingerprint?: string
  titleContentFingerprint?: string
  titleOriginFingerprint?: string
}


interface CodexThreadName {
  title: string
  updatedAt?: string
  source?: 'sqlite'
}

const CHECKPOINT_BATCH_SIZE = 100
const KNOWN_PROJECT_CWDS_CHECKPOINT_KEY = 'codex:known-project-cwds:v1'
export const CODEX_PARSER_VERSION = '12'

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}


export async function listJsonlFiles(root: string, historyWindow?: SourceHistoryWindow): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true })
  } catch (error) {
    if (isMissingPathError(error)) return []
    throw error
  }
  const paths = entries
    .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.jsonl')
    .map(entry => join(entry.parentPath, entry.name))

  // 大目录的无界并发 stat 会与实时监听和前台读取争用文件系统队列。
  const candidates: Array<{ path: string; mtimeMs: number }> = []
  const statBatchSize = 256
  for (let offset = 0; offset < paths.length; offset += statBatchSize) {
    const batch = await Promise.all(paths.slice(offset, offset + statBatchSize).map(async path => {
      try {
        return { path, mtimeMs: (await stat(path)).mtimeMs }
      } catch (error) {
        if (isMissingPathError(error)) return null
        throw error
      }
    }))
    for (const candidate of batch) if (candidate) candidates.push(candidate)
  }

  const activeSince = historyWindow?.activeSince ? Date.parse(historyWindow.activeSince) : Number.NaN
  const filtered = Number.isFinite(activeSince)
    ? candidates.filter(candidate => candidate.mtimeMs >= activeSince)
    : candidates
  const ordered = filtered.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path))
  const limit = historyWindow?.sessionLimit
  return (limit === undefined ? ordered : ordered.slice(0, Math.max(0, Math.floor(limit))))
    .map(candidate => candidate.path)
}

function sessionIdFromFilename(filePath: string): string {
  const match = basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  return match?.[1] ?? basename(filePath, extname(filePath))
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1000 : value
    return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : undefined
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

function chooseThreadName(
  previous: CodexThreadName | undefined,
  current: CodexThreadName,
): CodexThreadName {
  if (!previous) return current
  // SQLite holds the canonical Desktop title; the index alone cannot prove a rename.
  if (previous.source === 'sqlite' && current.source !== 'sqlite') return previous
  if (current.source === 'sqlite' && previous.source !== 'sqlite') return current
  // Where both timestamps exist, use the newest known title. Without a comparable
  // timestamp, the later source is preferred (SQLite follows the legacy index).
  if (previous.updatedAt && !current.updatedAt) return previous
  if (previous.updatedAt && current.updatedAt && previous.updatedAt > current.updatedAt) return previous
  return current
}

/** Codex Desktop's local thread metadata can be newer than session_index.jsonl. */
function readSqliteThreadNames(codexHome: string): Map<string, CodexThreadName> {
  const result = new Map<string, CodexThreadName>()
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true, timeout: 1000 })
    const rows = db.prepare('SELECT id, title, updated_at FROM threads').iterate() as Iterable<{
      id: unknown
      title: unknown
      updated_at: unknown
    }>
    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id.trim() : ''
      const title = typeof row.title === 'string' ? row.title.trim() : ''
      if (!id || !title) continue
      const updatedAt = normalizeTimestamp(row.updated_at)
      result.set(id, chooseThreadName(result.get(id), {
        title,
        ...(updatedAt ? { updatedAt } : {}),
        source: 'sqlite',
      }))
    }
  } catch {
    // CLI-only installs, older schema and locked/corrupt databases fall back to
    // the append-only index; never mutate Codex's native data.
  } finally {
    db?.close()
  }
  return result
}

async function readThreadNames(codexHome: string | undefined): Promise<Map<string, CodexThreadName>> {
  const result = new Map<string, CodexThreadName>()
  if (!codexHome) return result
  try {
    const text = await readFile(join(codexHome, 'session_index.jsonl'), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const entry = asRecord(JSON.parse(line))
        const id = typeof entry.id === 'string' ? entry.id.trim() : ''
        const title = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : ''
        if (!id || !title) continue
        const updatedAt = normalizeTimestamp(entry.updated_at)
        result.set(id, chooseThreadName(result.get(id), { title, ...(updatedAt ? { updatedAt } : {}) }))
      } catch {
        // session_index.jsonl 是 append-only；坏行不应阻断其他会话标题读取。
      }
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    // 旧版 Codex 可能不存在 session_index.jsonl，保持首条用户消息兜底。
  }
  for (const [id, native] of readSqliteThreadNames(codexHome)) {
    result.set(id, chooseThreadName(result.get(id), native))
  }
  return result
}

async function readSessionMetadata(
  filePath: string,
  indexedTitle?: CodexThreadName,
): Promise<CodexSessionMetadata> {
  const fallback: CodexSessionMetadata = {
    nativeSessionId: sessionIdFromFilename(filePath),
    ...(indexedTitle ? { title: indexedTitle.title, titleKind: indexedTitle.source === 'sqlite' ? 'generated' : 'unverified' } : {}),
  }
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(256 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const preview = buffer.subarray(0, bytesRead).toString('utf8')
    for (const line of preview.split(/\r?\n/).slice(0, 32)) {
      if (!line.trim()) continue
      try {
        const entry = asRecord(JSON.parse(line))
        const payload = asRecord(entry.payload)
        if (entry.type !== 'session_meta' || !Object.keys(payload).length) continue
        const startedAt = normalizeTimestamp(payload.timestamp)
        return {
          nativeSessionId: typeof payload.id === 'string' && payload.id ? payload.id : fallback.nativeSessionId,
          ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
          ...(typeof payload.cli_version === 'string' ? { cliVersion: payload.cli_version } : {}),
          ...(indexedTitle ? { title: indexedTitle.title, titleKind: indexedTitle.source === 'sqlite' ? 'generated' as const : 'unverified' as const } : {}),
          ...(startedAt ? { startedAt } : {}),
        }
      } catch {
        // Continue scanning; malformed records are preserved by the normal ingest path.
      }
    }
    return fallback
  } finally {
    await handle.close()
  }
}

function cwdPathKey(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function existingProjectCwds(values: readonly string[]): Promise<string[]> {
  const valid = new Map<string, string>()
  for (const value of values) {
    const raw = value.trim()
    if (!raw || !isAbsolute(raw)) continue
    const cwd = resolve(raw)
    let meta
    try {
      meta = await stat(cwd)
    } catch (error) {
      if (isMissingPathError(error)) continue
      throw error
    }
    if (!meta.isDirectory()) continue
    const key = cwdPathKey(cwd)
    if (!valid.has(key)) valid.set(key, cwd)
  }
  return [...valid.values()]
}

export async function listCodexProjectCwds(ctx: SourceExecutionContext): Promise<string[]> {
  const remembered = await ctx.checkpoint.get<string[]>(KNOWN_PROJECT_CWDS_CHECKPOINT_KEY)
  return remembered?.length ? existingProjectCwds(remembered) : []
}

function parseLine(text: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return {
      type: 'malformed-json',
      payload: { raw: text },
    }
  }
}

function checkpointKey(filePath: string): string {
  return `codex:history:${sha256(filePath)}`
}

function sourceRecordForLine(
  ctx: SourceExecutionContext,
  filePath: string,
  session: CodexSessionMetadata,
  line: JsonlLine,
  sequence: number,
): SourceRecord {
  const entry = parseLine(line.text)
  const fingerprint = sha256(line.text)
  const envelope: CodexStoredEnvelope = { entry, session }
  const nativeId = nativeIdForEntry(entry)
  const entryType = typeof entry.type === 'string' ? entry.type : ''
  const occurredAt = entryType === 'session_meta'
    ? session.startedAt ?? (typeof entry.timestamp === 'string' ? entry.timestamp : undefined)
    : typeof entry.timestamp === 'string' ? entry.timestamp : undefined

  return {
    id: `codex-record-${sha256(`${session.nativeSessionId}|${sequence}|${fingerprint}`).slice(0, 32)}`,
    sourceId: 'codex',
    installationId: ctx.installation.id,
    sourceSessionNativeId: session.nativeSessionId,
    nativeType: nativeTypeForEntry(entry),
    ...(nativeId ? { nativeId } : {}),
    sourceSequence: sequence,
    ...(occurredAt ? { occurredAt } : {}),
    capturedAt: new Date().toISOString(),
    locator: {
      kind: 'file',
      path: filePath,
      offset: line.startOffset,
    },
    fingerprint,
    payload: envelope,
    parserVersion: CODEX_PARSER_VERSION,
  }
}

function metadataCheckpointKey(filePath: string): string {
  return `codex:metadata:v2-session-summary:${sha256(filePath)}`
}

function metadataRecord(
  ctx: SourceExecutionContext,
  filePath: string,
  session: CodexSessionMetadata,
  kind: 'session_start' | 'session_title',
  indexedTitle?: CodexThreadName,
): SourceRecord | null {
  const title = session.title?.trim()
  if (kind === 'session_start' && !session.startedAt) return null
  if (kind === 'session_title' && !title) return null
  const recordKey = kind === 'session_start'
    ? `session-start:${session.nativeSessionId}`
    : `session-title:${session.nativeSessionId}:${sha256(title!).slice(0, 16)}`
  const payload = kind === 'session_start'
    ? { startedAt: session.startedAt }
    : { title, ...(session.titleKind ? { titleKind: session.titleKind } : {}), ...(indexedTitle?.updatedAt ? { updatedAt: indexedTitle.updatedAt } : {}) }
  return {
    id: `codex-metadata-${sha256(recordKey).slice(0, 32)}`,
    sourceId: 'codex',
    installationId: ctx.installation.id,
    sourceSessionNativeId: session.nativeSessionId,
    nativeType: `metadata/${kind}`,
    ...(kind === 'session_start' && session.startedAt ? { occurredAt: session.startedAt } : {}),
    capturedAt: new Date().toISOString(),
    locator: {
      kind: 'file',
      path: kind === 'session_title' && indexedTitle?.source === 'sqlite' && ctx.installation.configRoot
        ? join(ctx.installation.configRoot, 'state_5.sqlite')
        : kind === 'session_title' && ctx.installation.configRoot
          ? join(ctx.installation.configRoot, 'session_index.jsonl')
        : filePath,
    },
    fingerprint: sha256(JSON.stringify(payload)),
    payload: {
      entry: { type: kind, payload },
      session,
    } satisfies CodexStoredEnvelope,
    parserVersion: CODEX_PARSER_VERSION,
  }
}

async function* ingestCodexFileWithThreadNames(
  ctx: SourceExecutionContext,
  filePath: string,
  threadNames: Map<string, CodexThreadName>,
  onSession?: (session: CodexSessionMetadata) => void,
): AsyncIterable<SourceRecord> {
  if (ctx.abortSignal.aborted) return

  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
  const initialFileId = sourceFileIdentity(fileStat)
  const key = checkpointKey(filePath)
  const metadataKey = metadataCheckpointKey(filePath)
  const previous = await ctx.checkpoint.get<HistoryCheckpoint>(key)
  const previousMetadata = await ctx.checkpoint.get<MetadataCheckpoint>(metadataKey) ?? {}
  const fallbackId = sessionIdFromFilename(filePath)
  const session = await readSessionMetadata(filePath, threadNames.get(fallbackId))
  onSession?.(session)
  const indexedTitle = threadNames.get(session.nativeSessionId) ?? threadNames.get(fallbackId)
  if (indexedTitle) {
    session.title = indexedTitle.title
    session.titleKind = indexedTitle.source === 'sqlite' ? 'generated' : 'unverified'
  }

  const startRecord = metadataRecord(ctx, filePath, session, 'session_start', indexedTitle)
  const startFingerprint = startRecord?.fingerprint
  if (startRecord && startFingerprint && previousMetadata.startFingerprint !== startFingerprint) {
    yield startRecord
    previousMetadata.startFingerprint = startFingerprint
    await ctx.checkpoint.set(metadataKey, previousMetadata)
  }
  const titleRecord = metadataRecord(ctx, filePath, session, 'session_title', indexedTitle)
  const titleFingerprint = titleRecord?.fingerprint
  // threads.updated_at 是线程活动时间，不是标题修改时间；只比较标题内容。
  const titleContentFingerprint = session.title?.trim() ? sha256(session.title.trim()) : undefined
  const titleOriginFingerprint = titleContentFingerprint ? sha256(`${titleContentFingerprint}:${session.titleKind ?? 'unverified'}`) : undefined
  if (titleRecord && titleFingerprint && titleContentFingerprint
    && (previousMetadata.titleContentFingerprint !== titleContentFingerprint
      || previousMetadata.titleOriginFingerprint !== titleOriginFingerprint)) {
    yield titleRecord
    previousMetadata.titleFingerprint = titleFingerprint
    previousMetadata.titleContentFingerprint = titleContentFingerprint
    previousMetadata.titleOriginFingerprint = titleOriginFingerprint
    await ctx.checkpoint.set(metadataKey, previousMetadata)
  }

  // Parser upgrades are handled by Parser Replay. The history checkpoint advances in place
  // instead of forcing a full reread of an already-consumed rollout.
  if (previous && (
    previous.parserVersion !== CODEX_PARSER_VERSION
    || previous.fileId === undefined
  )) {
    await ctx.checkpoint.set(key, {
      ...previous,
      fileId: previous.fileId ?? initialFileId,
      parserVersion: CODEX_PARSER_VERSION,
    })
  }

  const sameKnownFile = previous?.fileId === undefined || previous.fileId === initialFileId
  const unchanged = previous
    && previous.path === filePath
    && sameKnownFile
    && previous.offset === fileStat.size
    && previous.size === fileStat.size
    && previous.mtimeMs === fileStat.mtimeMs
  if (unchanged) return

  const reset = !previous
    || previous.path !== filePath
    || (previous.fileId !== undefined && previous.fileId !== initialFileId)
    || fileStat.size < previous.offset
  let offset = reset ? 0 : previous.offset
  let sequence = reset ? 0 : previous.sequence
  let pendingCheckpointLines = 0
  let incompleteTail = false

  const persistCheckpoint = async () => {
    await ctx.checkpoint.set(key, {
      path: filePath,
      offset,
      sequence,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      fileId: initialFileId,
      parserVersion: CODEX_PARSER_VERSION,
    })
    pendingCheckpointLines = 0
  }

  for await (const line of readJsonlLines(filePath, offset)) {
    if (ctx.abortSignal.aborted) return
    if (!line.terminated && line.text.trim() && !isCompleteJson(line.text)) {
      incompleteTail = true
      break
    }

    sequence += 1
    offset = line.endOffset

    if (!line.text.trim()) {
      pendingCheckpointLines += 1
      if (pendingCheckpointLines >= CHECKPOINT_BATCH_SIZE) await persistCheckpoint()
      continue
    }

    yield sourceRecordForLine(ctx, filePath, session, line, sequence)
    pendingCheckpointLines += 1
    if (pendingCheckpointLines >= CHECKPOINT_BATCH_SIZE) await persistCheckpoint()
  }

  if (pendingCheckpointLines > 0) await persistCheckpoint()

  if (!ctx.abortSignal.aborted && !incompleteTail) {
    try {
      const finalStat = await stat(filePath)
      if (sourceFileIdentity(finalStat) === initialFileId
        && (finalStat.size !== fileStat.size || finalStat.mtimeMs !== fileStat.mtimeMs)) {
        await ctx.checkpoint.set(key, {
          path: filePath,
          offset,
          sequence,
          size: finalStat.size,
          mtimeMs: finalStat.mtimeMs,
          fileId: initialFileId,
          parserVersion: CODEX_PARSER_VERSION,
        })
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error
    }
  }
}

export async function* ingestCodexFile(
  ctx: SourceExecutionContext,
  filePath: string,
): AsyncIterable<SourceRecord> {
  const threadNames = await readThreadNames(ctx.installation.configRoot)
  yield* ingestCodexFileWithThreadNames(ctx, filePath, threadNames)
}

export async function* ingestCodexHistory(ctx: SourceHistoryExecutionContext): AsyncIterable<SourceRecord> {
  const sessionsDir = ctx.installation.dataRoot
    ?? (ctx.installation.configRoot ? join(ctx.installation.configRoot, 'sessions') : undefined)
  if (!sessionsDir) return

  const remembered = await ctx.checkpoint.get<string[]>(KNOWN_PROJECT_CWDS_CHECKPOINT_KEY) ?? []
  const knownCwds = new Map<string, string>()
  for (const value of remembered) {
    const raw = value.trim()
    if (!raw || !isAbsolute(raw)) continue
    const cwd = resolve(raw)
    knownCwds.set(cwdPathKey(cwd), cwd)
  }

  const rememberSession = (session: CodexSessionMetadata) => {
    const raw = session.cwd?.trim()
    if (!raw || !isAbsolute(raw)) return
    const cwd = resolve(raw)
    const key = cwdPathKey(cwd)
    if (!knownCwds.has(key)) knownCwds.set(key, cwd)
  }

  const threadNames = await readThreadNames(ctx.installation.configRoot)
  const files = await listJsonlFiles(sessionsDir, ctx.historyWindow)
  let processedUnits = 0
  await ctx.reportProgress?.({ phase: 'processing', discoveredUnits: files.length, processedUnits })
  for (const filePath of files) {
    if (ctx.abortSignal.aborted) return
    await ctx.reportProgress?.({ phase: 'processing', currentUnit: filePath })
    yield* ingestCodexFileWithThreadNames(ctx, filePath, threadNames, rememberSession)
    if (!ctx.abortSignal.aborted) await ctx.reportProgress?.({ phase: 'processing', processedUnits: ++processedUnits })
  }

  if (!ctx.abortSignal.aborted) {
    await ctx.checkpoint.set(KNOWN_PROJECT_CWDS_CHECKPOINT_KEY, [...knownCwds.values()])
  }
}

export const codexHistoryInternals = {
  CHECKPOINT_BATCH_SIZE,
  KNOWN_PROJECT_CWDS_CHECKPOINT_KEY,
  checkpointKey,
  listJsonlFiles,
  readThreadNames,
  readSqliteThreadNames,
  readSessionMetadata,
}
