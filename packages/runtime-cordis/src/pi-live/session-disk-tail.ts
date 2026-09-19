import { open } from 'node:fs/promises'

export const PI_SESSION_TAIL_PROBE_MAX_BYTES = 64 * 1024

function entryId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (row.type === 'session') return undefined
  return typeof row.id === 'string' && row.id.trim() ? row.id.trim() : undefined
}

/**
 * Reads only the bounded tail of a Pi JSONL session and returns the newest
 * complete persisted entry id. A partial first/last line is ignored safely.
 */
export async function latestPiSessionEntryId(
  filePath: string,
  maxBytes = PI_SESSION_TAIL_PROBE_MAX_BYTES,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'r')
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0) return undefined
    const length = Math.min(info.size, Math.max(1, Math.floor(maxBytes)))
    const start = Math.max(0, info.size - length)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    let text = buffer.subarray(0, bytesRead).toString('utf8')

    // A bounded tail may begin in the middle of a JSON line.
    if (start > 0) {
      const newline = text.indexOf('\n')
      if (newline < 0) return undefined
      text = text.slice(newline + 1)
    }

    const lines = text.split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim()
      if (!line) continue
      try {
        const id = entryId(JSON.parse(line))
        if (id) return id
      } catch {
        // A concurrently appended trailing line can be torn. Keep walking
        // backwards to the newest complete line instead of treating it as data.
      }
    }
    return undefined
  } catch (error) {
    if ((error as { code?: string } | undefined)?.code === 'ENOENT') return undefined
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
