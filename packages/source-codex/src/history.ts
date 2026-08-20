import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, opendir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { SourceExecutionContext, SourceRecord } from '@agent-lens/core'
import {
  nativeIdForEntry,
  nativeTypeForEntry,
  sanitizeCodexEntry,
  type CodexSessionMetadata,
  type CodexStoredEnvelope,
} from './format'

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

async function listJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for await (const file of walkJsonlFiles(root)) files.push(file)
  return files.sort((a, b) => a.localeCompare(b))
}

function sessionIdFromFilename(filePath: string): string {
  const match = basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  return match?.[1] ?? basename(filePath, extname(filePath))
}

async function readSessionMetadata(filePath: string): Promise<CodexSessionMetadata> {
  const fallback: CodexSessionMetadata = { nativeSessionId: sessionIdFromFilename(filePath) }
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
        return {
          nativeSessionId: String(entry.payload.id || fallback.nativeSessionId),
          ...(typeof entry.payload.cwd === 'string' ? { cwd: entry.payload.cwd } : {}),
          ...(typeof entry.payload.cli_version === 'string' ? { cliVersion: entry.payload.cli_version } : {}),
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

export async function* ingestCodexHistory(ctx: SourceExecutionContext): AsyncIterable<SourceRecord> {
  const sessionsDir = ctx.installation.dataRoot
    ?? join(ctx.installation.configRoot ?? '', 'sessions')
  if (!sessionsDir) return

  const files = await listJsonlFiles(sessionsDir)
  for (const filePath of files) {
    if (ctx.abortSignal.aborted) return

    const fileStat = await stat(filePath)
    const key = checkpointKey(filePath)
    const previous = await ctx.checkpoint.get<HistoryCheckpoint>(key)
    const reset = !previous || previous.path !== filePath || fileStat.size < previous.offset
    let offset = reset ? 0 : previous.offset
    let sequence = reset ? 0 : previous.sequence
    const session = await readSessionMetadata(filePath)

    for await (const line of readJsonlLines(filePath, offset)) {
      if (ctx.abortSignal.aborted) return
      sequence += 1
      offset = line.endOffset

      if (!line.text.trim()) {
        await ctx.checkpoint.set(key, {
          path: filePath,
          offset,
          sequence,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
        })
        continue
      }

      const rawEntry = parseLine(line.text)
      const entry = sanitizeCodexEntry(rawEntry)
      const fingerprint = sha256(line.text)
      const envelope: CodexStoredEnvelope = { entry, session }
      const nativeId = nativeIdForEntry(entry)

      const record: SourceRecord = {
        id: `codex-record-${sha256(`${session.nativeSessionId}|${sequence}|${fingerprint}`).slice(0, 32)}`,
        sourceId: 'codex',
        installationId: ctx.installation.id,
        sourceSessionNativeId: session.nativeSessionId,
        nativeType: nativeTypeForEntry(entry),
        ...(nativeId ? { nativeId } : {}),
        sourceSequence: sequence,
        ...(typeof entry.timestamp === 'string' ? { occurredAt: entry.timestamp } : {}),
        capturedAt: new Date().toISOString(),
        locator: {
          kind: 'file',
          path: filePath,
          offset: line.startOffset,
        },
        fingerprint,
        payload: envelope,
        parserVersion: '1',
      }

      yield record

      await ctx.checkpoint.set(key, {
        path: filePath,
        offset,
        sequence,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      })
    }
  }
}
