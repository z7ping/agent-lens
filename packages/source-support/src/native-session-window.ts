import { createHash } from 'node:crypto'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute, relative } from 'node:path'
import { sourceFileIdentity } from './source-fs'

/** Cursor is transient positioning metadata, not a durable copy of event content. */
export interface NativeSessionCursor {
  offset: number
  sequence: number
  fileIdentity: string
  /** SHA-256 over the bounded bytes preceding this read boundary. */
  boundaryHash?: string
}

export interface NativeSessionLine {
  entry: Record<string, unknown>
  textFingerprint: string
  boundaryHash: string
  offset: number
  sequence: number
}

export type NativeSessionWindowResult =
  | {
      state: 'available'
      lines: NativeSessionLine[]
      nextCursor: NativeSessionCursor
      hasMore: boolean
      /** A partial, unterminated tail is never delivered or skipped. */
      pendingTail: boolean
    }
  | { state: 'unavailable' | 'drifted' | 'unsupported'; reason: string }

const CHUNK_BYTES = 64 * 1024
const MAX_RECORD_BYTES = 2 * 1024 * 1024
const MAX_WINDOW_BYTES = 8 * 1024 * 1024
const MAX_WINDOW_RECORDS = 64
const CURSOR_BOUNDARY_BYTES = 256

async function hashAtBoundary(file: FileHandle, offset: number): Promise<string> {
  const length = Math.min(CURSOR_BOUNDARY_BYTES, offset)
  const buffer = Buffer.alloc(length)
  if (length) {
    const { bytesRead } = await file.read(buffer, 0, length, offset - length)
    if (bytesRead !== length) throw new Error('Native file changed during boundary verification')
  }
  return createHash('sha256').update(buffer).digest('hex')
}

function inside(root: string, child: string): boolean {
  const rel = relative(root, child)
  return (rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)))
}

/**
 * Read a bounded JSONL page directly from a Source-owned native file, without
 * any database checkpoints, Canonical writes, or whole-session in-memory scan.
 * Only trusted server-side catalog locators may reach this function.
 */
export async function readNativeSessionWindow(input: {
  path: string
  allowedRoots: readonly string[]
  cursor?: NativeSessionCursor
  limit?: number
  signal?: AbortSignal
}): Promise<NativeSessionWindowResult> {
  const { signal } = input
  const limit = input.limit ?? 32
  if (!isAbsolute(input.path) || extname(input.path).toLowerCase() !== '.jsonl'
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WINDOW_RECORDS
    || (input.cursor && (!Number.isSafeInteger(input.cursor.offset) || input.cursor.offset < 0
      || !Number.isSafeInteger(input.cursor.sequence) || input.cursor.sequence < 0
      || !input.cursor.fileIdentity
      || (input.cursor.boundaryHash !== undefined
        && !/^[0-9a-f]{64}$/.test(input.cursor.boundaryHash))))) {
    return { state: 'unsupported', reason: 'invalid-window-reference' }
  }
  signal?.throwIfAborted()
  let sourcePath: string
  try {
    sourcePath = await realpath(input.path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { state: 'unavailable', reason: 'native-file-missing' }
    if (code === 'EACCES' || code === 'EPERM') return { state: 'unavailable', reason: 'native-file-not-readable' }
    throw error
  }
  let allowed = false
  for (const root of input.allowedRoots) {
    if (!root || !isAbsolute(root)) continue
    try {
      if (inside(await realpath(root), sourcePath)) {
        allowed = true
        break
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  if (!allowed) return { state: 'unsupported', reason: 'source-path-not-authorized' }

  const file = await open(sourcePath, 'r')
  try {
    const current = await file.stat()
    if (!current.isFile()) return { state: 'unsupported', reason: 'native-source-is-not-a-file' }
    const fileIdentity = sourceFileIdentity(current)
    const offset = input.cursor?.offset ?? 0
    if (input.cursor && input.cursor.fileIdentity !== fileIdentity) {
      return { state: 'drifted', reason: 'native-file-identity-changed' }
    }
    if (offset > current.size) return { state: 'drifted', reason: 'native-file-shrank' }
    if (input.cursor?.boundaryHash
      && await hashAtBoundary(file, offset) !== input.cursor.boundaryHash) {
      return { state: 'drifted', reason: 'native-cursor-boundary-changed' }
    }
    if (offset > 0) {
      const previous = Buffer.alloc(1)
      const read = await file.read(previous, 0, 1, offset - 1)
      if (read.bytesRead !== 1 || previous[0] !== 0x0a) {
        return { state: 'drifted', reason: 'native-cursor-not-line-aligned' }
      }
    }
    const lines: NativeSessionLine[] = []
    let bytesReadInWindow = 0
    let start = offset
    let sequence = input.cursor?.sequence ?? 0
    let buffer = Buffer.alloc(0)
    let pendingTail = false

    while (lines.length < limit && bytesReadInWindow < MAX_WINDOW_BYTES) {
      signal?.throwIfAborted()
      const length = Math.min(CHUNK_BYTES, MAX_WINDOW_BYTES - bytesReadInWindow)
      const chunk = Buffer.allocUnsafe(length)
      const { bytesRead } = await file.read(chunk, 0, length, offset + bytesReadInWindow)
      if (bytesRead === 0) {
        pendingTail = buffer.length > 0
        break
      }
      bytesReadInWindow += bytesRead
      buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)])
      let newline: number
      while (lines.length < limit && (newline = buffer.indexOf(0x0a)) !== -1) {
        const lineEnd = start + newline + 1
        let raw = buffer.subarray(0, newline)
        if (raw.length && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, -1)
        if (raw.length > MAX_RECORD_BYTES) return { state: 'unsupported', reason: 'native-record-too-large' }
        const text = raw.toString('utf8')
        let entry: unknown
        if (text.trim()) {
          try {
            entry = JSON.parse(text.replace(/^\uFEFF/, ''))
          } catch {
            return { state: 'unsupported', reason: 'native-invalid-json' }
          }
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return { state: 'unsupported', reason: 'native-record-not-object' }
          }
        }
        sequence++
        if (entry) lines.push({
          entry: entry as Record<string, unknown>,
          boundaryHash: await hashAtBoundary(file, start),
          textFingerprint: createHash('sha256').update(text).digest('hex'),
          offset: start,
          sequence,
        })
        buffer = buffer.subarray(newline + 1)
        start = lineEnd
      }
      if (buffer.length > MAX_RECORD_BYTES + 2) {
        return { state: 'unsupported', reason: 'native-record-too-large' }
      }
    }
    if (bytesReadInWindow >= MAX_WINDOW_BYTES && lines.length === 0 && buffer.length) {
      return { state: 'unsupported', reason: 'native-window-byte-limit' }
    }
    signal?.throwIfAborted()
    // Do not advance past an incomplete tail (or past a lookahead in a full chunk).
    return {
      state: 'available',
      lines,
      nextCursor: {
        offset: start, sequence, fileIdentity,
        boundaryHash: await hashAtBoundary(file, start),
      },
      hasMore: start < current.size && (lines.length >= limit || buffer.length > 0 || bytesReadInWindow >= MAX_WINDOW_BYTES),
      pendingTail: pendingTail || (start < current.size && lines.length < limit && bytesReadInWindow < MAX_WINDOW_BYTES),
    }
  } finally {
    await file.close()
  }
}
