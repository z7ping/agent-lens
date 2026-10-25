import { createHash } from 'node:crypto'
import { link, lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

const MAX_EVENT_BYTES = 1024 * 1024
const MAX_FILES_PER_READ = 128

/** Source-owned Hook originals are the only durable recovery lane for
 * Hook-exclusive runtime facts. Archiving is on by default; an explicit
 * emergency opt-out keeps the original legacy inbox deletion behavior.
 * Archive uses link/unlink on the SAME filesystem (no second payload copy).
 */
export function nativeHookArchiveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_LENS_NATIVE_HOOK_ARCHIVE !== '0'
}

function opaqueSessionDirectory(nativeSessionId: string, installationId?: string): string {
  if (!nativeSessionId || nativeSessionId.length > 512) {
    throw new TypeError('Hook archive requires a valid native session identity')
  }
  if (installationId === undefined) {
    // Keep the legacy unscoped key readable via the explicit old helper API.
    // New Source readers always pass installationId, never auto-claim these
    // ambiguous legacy bytes under an unrelated installation.
    return createHash('sha256').update(nativeSessionId).digest('hex')
  }
  if (!installationId || installationId.length > 512) {
    throw new TypeError('Hook archive requires a valid installation identity')
  }
  return createHash('sha256').update(JSON.stringify([
    'native-hook-archive-v2', installationId, nativeSessionId,
  ])).digest('hex')
}

function safeInboxName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}\.json$/.test(name)
}

/** Internal Source-only locator. Never put the host path in HTTP DTOs. */
export function archivedHookInboxRecordPath(input: {
  inbox: string; fileName: string; nativeSessionId: string; installationId: string
}): string {
  if (!safeInboxName(input.fileName)) {
    throw new TypeError('Invalid original Hook inbox filename')
  }
  return join(input.inbox, 'archive',
    opaqueSessionDirectory(input.nativeSessionId, input.installationId),
    input.fileName)
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
  /** New sources must supply the Installation scope. Omitted only for legacy testing/read. */
  installationId?: string
}): Promise<void> {
  const { inbox, fileName, nativeSessionId, installationId } = input
  if (!safeInboxName(fileName) || basename(fileName) !== fileName) {
    throw new TypeError('Invalid original Hook inbox filename')
  }
  const sourcePath = join(inbox, fileName)
  const info = await lstat(sourcePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0
    || info.size > MAX_EVENT_BYTES) {
    throw new Error('Hook inbox event is not a bounded regular file')
  }
  const directory = join(inbox, 'archive', opaqueSessionDirectory(nativeSessionId, installationId))
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

/** A cursor is bound to one installation+session AND to the exact ordered
 * directory snapshot. A newly archived file can sort before a page cursor;
 * resume MUST reject that drift instead of silently skipping the new event.
 */
function hookArchiveSnapshot(names: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(names)).digest('hex')
}

function hookArchiveFileKey(name: string): string {
  return createHash('sha256').update(name).digest('hex')
}

function decodeHookCursor(
  value: string | undefined,
  session: string,
  snapshot: string,
): string | undefined {
  if (value === undefined) return undefined
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError('Invalid archived Hook cursor')
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError()
    const parts = parsed as Record<string, unknown>
    if (Object.keys(parts).length !== 4 || parts.version !== 2
      || parts.session !== session || parts.snapshot !== snapshot
      || typeof parts.after !== 'string' || !/^[0-9a-f]{64}$/.test(parts.after)) {
      throw new TypeError()
    }
    return parts.after
  } catch {
    throw new TypeError('Invalid archived Hook cursor')
  }
}

function encodeHookCursor(session: string, after: string, snapshot: string): string {
  // Hash the name instead of returning it: the client has neither host path
  // nor inbox basename, and the token size is bounded even for long names.
  return Buffer.from(JSON.stringify({
    version: 2, session, snapshot, after: hookArchiveFileKey(after),
  }), 'utf8').toString('base64url')
}

/** Bounded, stable archive pages. A page never silently drops files beyond its limit.
 * Old callers retain the original array API through readArchivedHookInboxSession.
 */
export async function readArchivedHookInboxPage(input: {
  inbox: string
  nativeSessionId: string
  installationId?: string
  limit?: number
  cursor?: string
}): Promise<{ items: Array<{ fileName: string; content: string }>;
  hasMore: boolean; nextCursor?: string }> {
  const limit = input.limit ?? MAX_FILES_PER_READ
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FILES_PER_READ) {
    throw new TypeError('Hook archive read limit out of range')
  }
  const session = opaqueSessionDirectory(input.nativeSessionId, input.installationId)
  const directory = join(input.inbox, 'archive', session)
  let names: string[]
  try {
    names = (await readdir(directory)).filter(safeInboxName).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      names = []
    } else {
      throw error
    }
  }
  const snapshot = hookArchiveSnapshot(names)
  const after = decodeHookCursor(input.cursor, session, snapshot)
  const afterIndex = after === undefined
    ? -1
    : names.findIndex(name => hookArchiveFileKey(name) === after)
  if (after !== undefined && afterIndex === -1) {
    throw new TypeError('Invalid archived Hook cursor')
  }
  const selected = names.slice(afterIndex + 1, afterIndex + 1 + limit + 1)
  const hasMore = selected.length > limit
  const items: Array<{ fileName: string; content: string }> = []
  for (const name of selected.slice(0, limit)) {
    const filePath = join(directory, name)
    const info = await lstat(filePath)
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_EVENT_BYTES) {
      throw new Error('Hook archive contains invalid event file')
    }
    const data = await readFile(filePath)
    if (data.length !== info.size) throw new Error('Hook archive event changed during read')
    items.push({ fileName: name, content: data.toString('utf8') })
  }
  return {
    items,
    hasMore,
    ...(hasMore && items.length
      ? { nextCursor: encodeHookCursor(session, items[items.length - 1]!.fileName, snapshot) }
      : {}),
  }
}

/** Compatibility first-page reader; callers requiring exact completeness must use page API. */
export async function readArchivedHookInboxSession(input: {
  inbox: string
  nativeSessionId: string
  installationId?: string
  limit?: number
}): Promise<Array<{ fileName: string; content: string }>> {
  return (await readArchivedHookInboxPage(input)).items
}
