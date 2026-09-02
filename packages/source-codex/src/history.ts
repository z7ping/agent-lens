import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, opendir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { SourceExecutionContext, SourceHistoryExecutionContext, SourceHistoryWindow, SourceRecord } from '@agent-lens/core'
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
  parserVersion?: string
}

interface MetadataCheckpoint {
  startFingerprint?: string
  titleFingerprint?: string
}

interface JsonlLine {
  text: string
  startOffset: number
  endOffset: number
}

interface CodexThreadName {
  title: string
  updatedAt?: string
}

const CHECKPOINT_BATCH_SIZE = 100
export const CODEX_PARSER_VERSION = '8'

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function* walkJsonlFiles(root: string): AsyncIterable<string> {
  let directory
  try {
    directory = await opendir(root)
  } catch {
    return
  }

  for await (const entry of directory) {
    const fullPath = join(root, entry.name)
    if (entry.isDirectory()) {
      yield* walkJsonlFiles(fullPath)
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.jsonl') {
      yield fullPath
    }
  }
}

async function listJsonlFiles(root: string, historyWindow?: SourceHistoryWindow): Promise<string[]> {
  const paths: string[] = []
  for await (const file of walkJsonlFiles(root)) paths.push(file)

  const candidates = (await Promise.all(paths.map(async path => {
    try {
      return { path, mtimeMs: (await stat(path)).mtimeMs }
    } catch {
      // 文件可能在目录遍历后被宿主清理，跳过即可。
      return null
    }
  }))).filter((candidate): candidate is { path: string; mtimeMs: number } => candidate !== null)

  // 冷启动首先导入最近有活动的会话；恢复旧会话时 mtime 比目录日期更可靠。
  // 路径降序只用于相同时间戳下的稳定排序，旧历史仍会在后续完整回填。
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
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

async function readThreadNames(codexHome: string | undefined): Promise<Map<string, CodexThreadName>> {
  const result = new Map<string, CodexThreadName>()
  if (!codexHome) return result
  try {
    const text = await readFile(join(codexHome, 'session_index.jsonl'), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        const id = typeof entry.id === 'string' ? entry.id.trim() : ''
        const title = typeof entry.thread_name === 'string' ? entry.thread_name.trim() : ''
        if (!id || !title) continue
        const updatedAt = normalizeTimestamp(entry.updated_at)
        result.set(id, { title, ...(updatedAt ? { updatedAt } : {}) })
      } catch {
        // session_index.jsonl 是 append-only；坏行不应阻断其他会话标题读取。
      }
    }
  } catch {
    // 旧版 Codex 可能不存在 session_index.jsonl，保持首条用户消息兜底。
  }
  return result
}

async function readSessionMetadata(
  filePath: string,
  indexedTitle?: CodexThreadName,
): Promise<CodexSessionMetadata> {
  const fallback: CodexSessionMetadata = {
    nativeSessionId: sessionIdFromFilename(filePath),
    ...(indexedTitle ? { title: indexedTitle.title } : {}),
  }
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(256 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const preview = buffer.subarray(0, bytesRead).toString('utf8')
    for (const line of preview.split(/\r?\n/).slice(0, 32)) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as Record<string, any>
        if (entry.type !== 'session_meta' || !entry.payload) continue
        const startedAt = normalizeTimestamp(entry.payload.timestamp)
        return {
          nativeSessionId: String(entry.payload.id || fallback.nativeSessionId),
          ...(typeof entry.payload.cwd === 'string' ? { cwd: entry.payload.cwd } : {}),
          ...(typeof entry.payload.cli_version === 'string' ? { cliVersion: entry.payload.cli_version } : {}),
          ...(indexedTitle ? { title: indexedTitle.title } : {}),
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

async function* readJsonlLines(
  filePath: string,
  startOffset: number,
  endOffset?: number,
): AsyncIterable<JsonlLine> {
  if (endOffset !== undefined && endOffset <= startOffset) return
  const stream = createReadStream(filePath, {
    start: startOffset,
    ...(endOffset === undefined ? {} : { end: endOffset - 1 }),
  })
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

function parseLine(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return {
      type: 'malformed-json',
      payload: { raw: text.slice(0, 16 * 1024) },
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
  const nativeId = kind === 'session_start'
    ? `session-start:${session.nativeSessionId}`
    : `session-title:${session.nativeSessionId}:${sha256(title!).slice(0, 16)}`
  const payload = kind === 'session_start'
    ? { startedAt: session.startedAt }
    : { title, ...(indexedTitle?.updatedAt ? { updatedAt: indexedTitle.updatedAt } : {}) }
  return {
    id: `codex-metadata-${sha256(nativeId).slice(0, 32)}`,
    sourceId: 'codex',
    installationId: ctx.installation.id,
    sourceSessionNativeId: session.nativeSessionId,
    nativeType: `metadata/${kind}`,
    nativeId,
    ...(kind === 'session_start' && session.startedAt ? { occurredAt: session.startedAt } : {}),
    capturedAt: new Date().toISOString(),
    locator: {
      kind: 'file',
      path: kind === 'session_title' && ctx.installation.configRoot
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

export async function* ingestCodexHistory(ctx: SourceHistoryExecutionContext): AsyncIterable<SourceRecord> {
  const sessionsDir = ctx.installation.dataRoot
    ?? (ctx.installation.configRoot ? join(ctx.installation.configRoot, 'sessions') : undefined)
  if (!sessionsDir) return

  const threadNames = await readThreadNames(ctx.installation.configRoot)
  const files = await listJsonlFiles(sessionsDir, ctx.historyWindow)
  for (const filePath of files) {
    if (ctx.abortSignal.aborted) return

    const fileStat = await stat(filePath)
    const key = checkpointKey(filePath)
    const metadataKey = metadataCheckpointKey(filePath)
    const previous = await ctx.checkpoint.get<HistoryCheckpoint>(key)
    const previousMetadata = await ctx.checkpoint.get<MetadataCheckpoint>(metadataKey) ?? {}
    const fallbackId = sessionIdFromFilename(filePath)
    const session = await readSessionMetadata(filePath, threadNames.get(fallbackId))
    const indexedTitle = threadNames.get(session.nativeSessionId) ?? threadNames.get(fallbackId)
    if (indexedTitle && session.title !== indexedTitle.title) session.title = indexedTitle.title

    const startRecord = metadataRecord(ctx, filePath, session, 'session_start', indexedTitle)
    const startFingerprint = startRecord?.fingerprint
    if (startRecord && startFingerprint && previousMetadata.startFingerprint !== startFingerprint) {
      yield startRecord
      previousMetadata.startFingerprint = startFingerprint
      await ctx.checkpoint.set(metadataKey, previousMetadata)
    }
    const titleRecord = metadataRecord(ctx, filePath, session, 'session_title', indexedTitle)
    const titleFingerprint = titleRecord?.fingerprint
    if (titleRecord && titleFingerprint && previousMetadata.titleFingerprint !== titleFingerprint) {
      yield titleRecord
      previousMetadata.titleFingerprint = titleFingerprint
      await ctx.checkpoint.set(metadataKey, previousMetadata)
    }

    // Parser v4 changes the persisted SourceRecord contract: native JSON is no longer
    // field-pruned inside the Codex adapter. Replay the already-consumed prefix once so
    // deterministic SourceRecord ids are upserted with the safe, complete native payload.
    if (previous && previous.parserVersion !== CODEX_PARSER_VERSION) {
      let legacySequence = 0
      for await (const line of readJsonlLines(filePath, 0, previous.offset)) {
        if (ctx.abortSignal.aborted) return
        legacySequence += 1
        if (!line.text.trim()) continue
        yield sourceRecordForLine(ctx, filePath, session, line, legacySequence)
      }
      await ctx.checkpoint.set(key, { ...previous, parserVersion: CODEX_PARSER_VERSION })
    }

    const unchanged = previous
      && previous.path === filePath
      && previous.offset === fileStat.size
      && previous.size === fileStat.size
      && previous.mtimeMs === fileStat.mtimeMs
    if (unchanged) continue

    const reset = !previous || previous.path !== filePath || fileStat.size < previous.offset
    let offset = reset ? 0 : previous.offset
    let sequence = reset ? 0 : previous.sequence
    let pendingCheckpointLines = 0

    const persistCheckpoint = async () => {
      await ctx.checkpoint.set(key, {
        path: filePath,
        offset,
        sequence,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        parserVersion: CODEX_PARSER_VERSION,
      })
      pendingCheckpointLines = 0
    }

    for await (const line of readJsonlLines(filePath, offset)) {
      if (ctx.abortSignal.aborted) break
      sequence += 1
      offset = line.endOffset

      if (!line.text.trim()) {
        pendingCheckpointLines += 1
        if (pendingCheckpointLines >= CHECKPOINT_BATCH_SIZE) await persistCheckpoint()
        continue
      }

      yield sourceRecordForLine(ctx, filePath, session, line, sequence)
      // 生成器只会在消费端持久化当前记录后继续执行。批量推进游标可以避免
      // 冷导入为每行 JSONL 增加一次 SQLite 事务；崩溃时最多幂等重放一批。
      pendingCheckpointLines += 1
      if (pendingCheckpointLines >= CHECKPOINT_BATCH_SIZE) await persistCheckpoint()
    }

    if (pendingCheckpointLines > 0) await persistCheckpoint()
    if (ctx.abortSignal.aborted) return
  }
}

export const codexHistoryInternals = {
  CHECKPOINT_BATCH_SIZE,
  checkpointKey,
  listJsonlFiles,
  readThreadNames,
  readSessionMetadata,
}
