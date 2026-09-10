import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export const SERVICE_LOG_MAX_BYTES = 2 * 1024 * 1024

export interface BoundedLogSink {
  write(chunk: string | Buffer): void
}

function currentSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function rotate(path: string): void {
  const previous = `${path}.1`
  rmSync(previous, { force: true })
  try {
    renameSync(path, previous)
  } catch {
    // The active file may not exist yet.
  }
}

export function createBoundedLogSink(
  path: string,
  maxBytes = SERVICE_LOG_MAX_BYTES,
): BoundedLogSink {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be greater than zero')
  mkdirSync(dirname(path), { recursive: true })
  let size = currentSize(path)

  return {
    write(chunk): void {
      try {
        let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (!data.length) return
        if (data.length > maxBytes) data = data.subarray(data.length - maxBytes)

        if (size + data.length > maxBytes) {
          rotate(path)
          size = 0
        }

        if (size === 0) writeFileSync(path, data)
        else appendFileSync(path, data)
        size += data.length
      } catch {
        // Background logging must never terminate the managed runtime.
      }
    },
  }
}
