import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'

/**
 * Native JSONL hydration primitive for a Source-authorized location.
 *
 * Reads a bounded record from ONE open file handle. The very same bytes are
 * fingerprinted and parsed: callers must not verify, close, reopen and parse.
 *
 * This utility does not grant path authorization. Source/Reader must validate
 * installation identity, source roots, capture policy and access to the path.
 */
export type NativeJsonlReadResult =
  | { state: 'available'; entry: Record<string, unknown>; fingerprint: string; bytesRead: number }
  | { state: 'unavailable'; reason: 'source-file-missing' | 'source-file-not-readable' | 'source-offset-missing' }
  | { state: 'drifted'; reason: 'source-content-fingerprint-changed'; currentFingerprint: string }
  | { state: 'pending'; reason: 'source-record-not-terminated' }
  | { state: 'unsupported'; reason: 'source-reference-incomplete' | 'source-record-too-large' | 'source-record-not-object' | 'source-record-invalid-json' }

const DEFAULT_MAX_RECORD_BYTES = 2 * 1024 * 1024
const ABSOLUTE_MAX_RECORD_BYTES = 2 * 1024 * 1024
const READ_CHUNK_BYTES = 64 * 1024

export async function readVerifiedNativeJsonlObject(input: {
  path?: string
  offset?: number
  expectedFingerprint?: string
  maxRecordBytes?: number
  abortSignal?: AbortSignal
}): Promise<NativeJsonlReadResult> {
  const { path, offset, expectedFingerprint, abortSignal } = input
  if (!path || !Number.isSafeInteger(offset) || offset! < 0
    || !expectedFingerprint || !/^[0-9a-f]{64}$/i.test(expectedFingerprint)) {
    return { state: 'unsupported', reason: 'source-reference-incomplete' }
  }

  const requestedLimit = input.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    return { state: 'unsupported', reason: 'source-reference-incomplete' }
  }
  const maxRecordBytes = Math.min(requestedLimit, ABSOLUTE_MAX_RECORD_BYTES)
  abortSignal?.throwIfAborted()

  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { state: 'unavailable', reason: 'source-file-missing' }
    if (code === 'EACCES' || code === 'EPERM') {
      return { state: 'unavailable', reason: 'source-file-not-readable' }
    }
    throw error
  }

  try {
    const file = await handle.stat()
    if (!file.isFile() || offset! >= file.size) {
      return { state: 'unavailable', reason: 'source-offset-missing' }
    }

    const chunks: Buffer[] = []
    let total = 0
    let terminated = false
    // One extra byte is permitted for LF (and another for optional CR).
    const readBudget = maxRecordBytes + 2
    while (total < readBudget) {
      abortSignal?.throwIfAborted()
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, readBudget - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset! + total)
      if (bytesRead === 0) break
      const bytes = chunk.subarray(0, bytesRead)
      const newline = bytes.indexOf(0x0a)
      if (newline >= 0) {
        chunks.push(bytes.subarray(0, newline))
        total += newline
        terminated = true
        break
      }
      chunks.push(bytes)
      total += bytesRead
    }
    abortSignal?.throwIfAborted()

    if (!terminated) {
      if (total >= readBudget) return { state: 'unsupported', reason: 'source-record-too-large' }
      return { state: 'pending', reason: 'source-record-not-terminated' }
    }

    const raw = Buffer.concat(chunks, total)
    const content = raw.length && raw[raw.length - 1] === 0x0d
      ? raw.subarray(0, -1) : raw
    if (content.length > maxRecordBytes) {
      return { state: 'unsupported', reason: 'source-record-too-large' }
    }
    const text = content.toString('utf8')
    const fingerprint = createHash('sha256').update(text).digest('hex')
    if (fingerprint.toLowerCase() !== expectedFingerprint.toLowerCase()) {
      return { state: 'drifted', reason: 'source-content-fingerprint-changed', currentFingerprint: fingerprint }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch {
      return { state: 'unsupported', reason: 'source-record-invalid-json' }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: 'unsupported', reason: 'source-record-not-object' }
    }
    return { state: 'available', entry: parsed as Record<string, unknown>, fingerprint, bytesRead: raw.length + 1 }
  } finally {
    await handle.close()
  }
}
