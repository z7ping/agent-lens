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

/** 从既有 Canonical 文件事件恢复旧历史摘要，查询有界，不读取当前工作区。 */
export async function observedSessionFileChanges(storage: StorageService, logicalSessionId: string) {
  const observations = await storage.repositories.observations.query({
    logicalSessionIds: [logicalSessionId], kind: 'artifact.action', order: 'desc', limit: MAX_ROUND_OBSERVATIONS + 1,
  })
  return {
    items: summarizeObservedTaskFileChanges(observedTaskFileChanges(observations.slice(0, MAX_ROUND_OBSERVATIONS).reverse())),
    truncated: observations.length > MAX_ROUND_OBSERVATIONS,
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
