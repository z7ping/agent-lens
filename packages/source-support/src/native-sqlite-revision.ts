import { stat } from 'node:fs/promises'

/** A native SQLite database may append to its -wal without touching the
 * main .db file. For derived metadata/metrics revisions only, combine the
 * main file and WAL sizes/timestamps, while retaining the real main inode
 * as the Source Reader's authorization identity.
 *
 * This is a cheap metadata observation, NOT proof of a frozen SQLite
 * transaction or an immutable historical record. Source readers still own
 * snapshot isolation and cursor-boundary checks.
 */
export async function nativeSqliteRevision(
  path: string,
  primary?: Awaited<ReturnType<typeof stat>>,
): Promise<{ fileIdentity:string; fileSize:number; fileMtimeMs:number }> {
  const db = primary ?? await stat(path)
  if (!db.isFile()) throw new TypeError('Original native database must be a regular file')
  let wal: Awaited<ReturnType<typeof stat>> | undefined
  try {
    wal = await stat(`${path}-wal`)
  } catch (error) {
    if (!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
  if (wal && !wal.isFile()) throw new TypeError('Native database WAL must be a regular file')
  const fileSize=db.size+(wal?.size??0)
  const fileMtimeMs=Math.max(db.mtimeMs,wal?.mtimeMs??0)
  if (!Number.isSafeInteger(fileSize) || fileSize<0
    || !Number.isFinite(fileMtimeMs) || fileMtimeMs<0) {
    throw new TypeError('Invalid native database revision')
  }
  return {
    fileIdentity:`${db.dev}:${db.ino}`,
    fileSize,fileMtimeMs,
  }
}
