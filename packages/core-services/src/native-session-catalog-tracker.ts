import { stat } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import type {
  NativeSessionCatalogStore,
  SourceDefinition,
  SourceRecord,
} from '@agent-lens/core'

/**
 * Piggyback lightweight directory changes on already-observed Source records.
 * This is not an additional startup scan and never stores record payload.
 */
export class NativeSessionCatalogTracker {
  private readonly inspected = new Map<string, { checkedAt: number; activityMs: number }>()

  constructor(
    private readonly catalog?: NativeSessionCatalogStore,
    private readonly now: () => number = Date.now,
    private readonly minRefreshMs = 30_000,
  ) {}

  async observe(source: SourceDefinition, record: SourceRecord): Promise<boolean> {
    const originalFile = record.locator.kind === 'file'
      && extname(record.locator.path ?? '').toLowerCase() === '.jsonl'
    const originalDatabase = record.locator.kind === 'database'
      && (record.locator.table === 'messages' || record.locator.table === 'part')
      && (extname(record.locator.path ?? '').toLowerCase() === '.db'
        || extname(record.locator.path ?? '').toLowerCase() === '.sqlite')
    if (!this.catalog || !source.readNativeSessionPage || record.sourceId !== source.manifest.sourceId
      || !record.sourceSessionNativeId
      || (!originalFile && !originalDatabase)
      || !record.locator.path || !isAbsolute(record.locator.path)
      || !source.rawRecovery?.describe(record).canReread) return false

    const path = record.locator.path
    const key = `${record.sourceId}\u0000${record.installationId}\u0000${record.sourceSessionNativeId}\u0000${path}`
    const now = this.now()
    const previous = this.inspected.get(key)
    const nativeActivityMs = originalDatabase && record.occurredAt
      ? Date.parse(record.occurredAt)
      : Number.NaN
    const activityMs = Number.isFinite(nativeActivityMs) ? nativeActivityMs : Number.NEGATIVE_INFINITY
    // SQLite WAL may leave the main DB mtime unchanged. During a fast import,
    // update activity at most once per 5 native minutes even if wall clock
    // throttling has not expired. This keeps long-lived sessions discoverable
    // without one SQLite catalog write for every message.
    const significantActivity = originalDatabase && previous
      && activityMs - previous.activityMs >= 5 * 60_000
    if (previous && now - previous.checkedAt < this.minRefreshMs && !significantActivity) return false
    // Limit memory, even during long multi-source history scans.
    if (this.inspected.size >= 1024) {
      const oldest = this.inspected.keys().next().value
      if (oldest !== undefined) this.inspected.delete(oldest)
    }
    this.inspected.set(key, {
      checkedAt: now,
      activityMs: Math.max(previous?.activityMs ?? Number.NEGATIVE_INFINITY, activityMs),
    })

    let file
    try {
      file = await stat(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
        // Source file temporarily missing/inaccessible is not a deletion tombstone.
        return false
      }
      throw error
    }
    if (!file.isFile() || !Number.isFinite(file.mtimeMs) || file.mtimeMs < 0) return false
    await this.catalog.upsert({
      sourceId: record.sourceId,
      installationId: record.installationId,
      nativeSessionId: record.sourceSessionNativeId,
      // Codex's native archived_sessions is still a Codex-native storage root.
      // The 'archive' catalog status is reserved for verified AgentLens Vault archives.
      locationKind: 'native',
      filePath: path,
      fileIdentity: `${file.dev}:${file.ino}`,
      fileSize: file.size,
      fileMtimeMs: file.mtimeMs,
      // SQLite can be in WAL mode: the main DB mtime need not advance on
      // a new session message. Prefer the native event clock when valid.
      lastActivityAt: originalDatabase && record.occurredAt
        && Number.isFinite(Date.parse(record.occurredAt))
        ? new Date(record.occurredAt).toISOString()
        : new Date(file.mtimeMs).toISOString(),
      updatedAt: new Date(now).toISOString(),
    })
    return true
  }
}
