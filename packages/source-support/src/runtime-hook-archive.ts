import { createHash } from 'node:crypto'
import { link, lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

const MAX_EVENT_BYTES = 1024 * 1024
const MAX_FILES_PER_READ = 128

function opaqueSessionDirectory(nativeSessionId: string): string {
  if (!nativeSessionId || nativeSessionId.length > 512) {
    throw new TypeError('Hook archive requires a valid native session identity')
  }
  return createHash('sha256').update(nativeSessionId).digest('hex')
}

function safeInboxName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}\.json$/.test(name)
}

/**
 * Move the one original source Hook inbox inode into a durable, per-session
 * namespace AFTER the legacy emitter acknowledged it. No content copy, no
 * reserialization, no replacement of a conflicting event.
 *
 * Linking into a same-filesystem archive before unlinking the inbox entry
 * preserves recoverability across interruption, including after a crash
 * between the two filesystem operations.
 */
export async function archiveAcceptedHookInboxFile(input: {
  inbox: string
  fileName: string
  nativeSessionId: string
}): Promise<void> {
  const { inbox, fileName, nativeSessionId } = input
  if (!safeInboxName(fileName) || basename(fileName) !== fileName) {
    throw new TypeError('Invalid original Hook inbox filename')
  }
  const sourcePath = join(inbox, fileName)
  const info = await lstat(sourcePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0
    || info.size > MAX_EVENT_BYTES) {
    throw new Error('Hook inbox event is not a bounded regular file')
  }
  const directory = join(inbox, 'archive', opaqueSessionDirectory(nativeSessionId))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const targetPath = join(directory, fileName)
  try {
    await link(sourcePath, targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const [existing, current] = await Promise.all([readFile(targetPath), readFile(sourcePath)])
    // Retries are safe only when the archive contains byte-for-byte the same
    // original event. Never overwrite a conflicting original Hook record.
    if (!existing.equals(current)) throw new Error('Hook archive filename collision')
  }
  await unlink(sourcePath)
}

/** Read one source-owned archived session without returning host filesystem paths. */
export async function readArchivedHookInboxSession(input: {
  inbox: string
  nativeSessionId: string
  limit?: number
}): Promise<Array<{ fileName: string; content: string }>> {
  const limit = input.limit ?? MAX_FILES_PER_READ
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FILES_PER_READ) {
    throw new TypeError('Hook archive read limit out of range')
  }
  const directory = join(input.inbox, 'archive', opaqueSessionDirectory(input.nativeSessionId))
  let names: string[]
  try {
    names = (await readdir(directory)).filter(safeInboxName).sort().slice(0, limit)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const items: Array<{ fileName: string; content: string }> = []
  for (const name of names) {
    const filePath = join(directory, name)
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_EVENT_BYTES) {
      throw new Error('Hook archive contains invalid event file')
    }
    const data = await readFile(filePath)
    if (data.length !== info.size) throw new Error('Hook archive event changed during read')
    items.push({fileName:name,content:data.toString('utf8')})
  }
  return items
}
