import type { CanonicalObservation, ObservationCursor, StorageService, TaskFileChangeRecord } from '@agent-lens/core'
import { observedTaskFileChanges, summarizeObservedTaskFileChanges } from '@agent-lens/projection-session'
import { AGENT_LENS_PROTOCOL_VERSION, type TaskFileChangesResponseDto } from '@agent-lens/protocol'

const PAGE_SIZE = 500
const MAX_ROUND_OBSERVATIONS = 5000

function cursorFor(observation: CanonicalObservation): ObservationCursor {
  const sequence = observation.canonicalSequence ?? observation.sourceSequence
  return {
    effectiveAt: observation.occurredAt ?? observation.capturedAt,
    ...(sequence === undefined ? {} : { sequence }),
    id: observation.id,
  }
}

/** Per-round read is evidence-only: a session Git Tree diff cannot be attributed to a particular turn. */
export async function observedInteractionFileChanges(
  storage: StorageService,
  logicalSessionId: string,
  interactionId: string,
  from: string,
  to: string,
): Promise<{ items: TaskFileChangeRecord[]; truncated: boolean }> {
  const observations: CanonicalObservation[] = []
  let after: ObservationCursor | undefined
  let truncated = false
  let scanned = 0
  while (scanned < MAX_ROUND_OBSERVATIONS) {
    const page = await storage.repositories.observations.query({
      logicalSessionIds: [logicalSessionId],
      from,
      to,
      ...(after ? { after } : {}),
      order: 'asc',
      limit: PAGE_SIZE,
    })
    scanned += page.length
    observations.push(...page.filter(item => item.interactionId === interactionId))
    if (page.length < PAGE_SIZE) break
    if (scanned >= MAX_ROUND_OBSERVATIONS) { truncated = true; break }
    after = cursorFor(page[page.length - 1]!)
  }
  return { items: summarizeObservedTaskFileChanges(observedTaskFileChanges(observations)), truncated }
}


// 旧会话只从既有 Canonical 工具与原生文件事件补算；不猜测 Shell 副作用，
// 不扫描整个数据库，也不伪造 Git 基线。
const MAX_LEGACY_OBSERVATIONS = 5_000
const LEGACY_EMPTY_CACHE_MS = 60_000
const LEGACY_CACHE_LIMIT = 128
type LegacyResult = { items: TaskFileChangeRecord[]; truncated: boolean }
const legacyCache = new WeakMap<StorageService, Map<string, {
  expiresAt: number
  pending: Promise<LegacyResult>
}>>()

export async function backfillLegacySessionFileChanges(
  storage: StorageService,
  logicalSessionId: string,
): Promise<LegacyResult> {
  const existing = legacyCache.get(storage) ?? new Map<string, {
    expiresAt: number
    pending: Promise<LegacyResult>
  }>()
  legacyCache.set(storage, existing)
  const cached = existing.get(logicalSessionId)
  if (cached && cached.expiresAt > Date.now()) return cached.pending

  const pending = (async (): Promise<LegacyResult> => {
    const observations: CanonicalObservation[] = []
    let after: ObservationCursor | undefined
    let truncated = false
    while (observations.length < MAX_LEGACY_OBSERVATIONS) {
      const page = await storage.repositories.observations.query({
        logicalSessionIds: [logicalSessionId],
        ...(after ? { after } : {}),
        order: 'asc',
        limit: PAGE_SIZE,
      })
      observations.push(...page)
      if (page.length < PAGE_SIZE) break
      if (observations.length >= MAX_LEGACY_OBSERVATIONS) { truncated = true; break }
      after = cursorFor(page[page.length - 1]!)
    }
    const items = summarizeObservedTaskFileChanges(observedTaskFileChanges(observations))
    // Partial scans must not be persisted as authoritative full-session facts.
    // Existing finalized captures must remain untouched (caller skips them).
    if (!truncated && items.length && storage.taskFileChanges) {
      await storage.taskFileChanges.replaceObservedSession(logicalSessionId, items)
    }
    return { items, truncated }
  })()

  if (existing.size >= LEGACY_CACHE_LIMIT) existing.delete(existing.keys().next().value!)
  existing.set(logicalSessionId, { expiresAt: Date.now() + LEGACY_EMPTY_CACHE_MS, pending })
  try {
    return await pending
  } catch (error) {
    existing.delete(logicalSessionId)
    throw error
  }
}

export function taskFileChangesResponse(
  logicalSessionId: string,
  items: readonly TaskFileChangeRecord[],
  capture?: { workspacePath?: string | undefined; gitRootPath?: string | undefined } | null,
  options: { interactionId?: string; truncated?: boolean } = {},
): TaskFileChangesResponseDto {
  const counted = items.filter(item => item.additions !== undefined || item.deletions !== undefined)
  return {
    logicalSessionId,
    ...(options.interactionId ? { interactionId: options.interactionId } : {}),
    ...(capture?.workspacePath ? { workspacePath: capture.workspacePath } : {}),
    ...(capture?.gitRootPath ? { rootPath: capture.gitRootPath } : {}),
    items: items.map(item => ({
      path: item.path,
      changeType: item.changeType,
      ...(item.oldPath ? { oldPath: item.oldPath } : {}),
      ...(item.additions === undefined ? {} : { additions: item.additions }),
      ...(item.deletions === undefined ? {} : { deletions: item.deletions }),
      firstChangedAt: item.firstChangedAt,
      lastChangedAt: item.lastChangedAt,
      evidence: [...item.evidence],
      confidence: item.confidence,
    })),
    summary: {
      count: items.length,
      ...(counted.length ? {
        additions: counted.reduce((sum, item) => sum + (item.additions ?? 0), 0),
        deletions: counted.reduce((sum, item) => sum + (item.deletions ?? 0), 0),
      } : {}),
      exactCount: items.filter(item => item.confidence === 'exact').length,
      observedCount: items.filter(item => item.confidence !== 'exact').length,
    },
    meta: {
      protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
      generatedAt: new Date().toISOString(),
      ...(options.truncated ? { truncated: true } : {}),
    },
  }
}
