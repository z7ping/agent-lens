import {
  AGENT_LENS_PROTOCOL_VERSION,
  type TaskFileChangesResponseDto,
  type NativeReviewWindowDto,
  type NativeSessionSummaryDto,
  type ReviewSessionDetailDto,
} from '@agent-lens/protocol'

/**
 * Adapter into the ONE Task Surface Review DTO. This is a bounded page, not a
 * fabricated SessionSummary projection: all aggregate metrics are window-only
 * and the UI must not label them as complete session facts.
 */
export function nativeReviewDetail(
  summary: NativeSessionSummaryDto,
  window: NativeReviewWindowDto,
): ReviewSessionDetailDto {
  if (window.state !== 'available' || window.boundaryIntegrity !== 'complete'
    || window.pagingUnit !== 'interaction' || window.sessionId !== summary.id
    || window.sourceId !== summary.sourceId
    || window.installationId !== summary.installationId
    || window.nativeSessionId !== summary.nativeSessionId) {
    throw new Error('Native Review identity or complete-turn contract changed')
  }
  const interactions = window.interactions
  const toolCount = interactions.reduce((count, item) =>
    count + item.nodes.filter(node => node.type === 'tool').length, 0)
  const errorCount = interactions.reduce((count, item) =>
    count + item.nodes.filter(node => node.type === 'tool' && node.status === 'error').length, 0)
  const first = interactions[0]?.startedAt ?? summary.lastActivityAt
  const end = summary.lastActivityAt
  const duration = Date.parse(end) - Date.parse(first)
  const nativeTitle = summary.title?.trim()
  return {
    id: summary.id,
    sourceIds: [summary.sourceId],
    productId: summary.sourceId,
    installationId: summary.installationId,
    ...(nativeTitle ? { title: nativeTitle, titleKind: 'explicit' as const } : {}),
    startedAt: first,
    endedAt: end,
    durationMs: Number.isFinite(duration) ? Math.max(0, duration) : 0,
    observationCount: window.observationCount,
    interactionCount: interactions.filter(item => item.trigger === 'user').length,
    toolCount,
    errorCount,
    hasErrors: errorCount > 0,
    // Deliberately not a full SQL SessionSummary. Counts and duration reflect
    // only visible native observations; the header hides total metrics.
    statisticsCompleteness: 'window',
    interactions,
    page: {
      count: interactions.length,
      hasMore: window.hasMore,
      ...(window.hasMore ? { nextCursor: window.nextCursor } : {}),
      direction: 'forward',
      filter: 'all',
    },
  }
}

export function nativeReviewNextPage(
  current: ReviewSessionDetailDto,
  window: NativeReviewWindowDto,
): ReviewSessionDetailDto {
  if (current.statisticsCompleteness !== 'window') {
    throw new Error('Cannot join a native page to a persisted Review session')
  }
  return nativeReviewDetail({
    id: current.id,
    sourceId: current.sourceIds[0] ?? current.productId,
    nativeSessionId: window.nativeSessionId,
    installationId: current.installationId,
    locationKind: 'native',
    lastActivityAt: current.endedAt,
    ...(current.title ? { title: current.title } : {}),
  }, window)
}

/** Reconstruct evidence-based changes from native pages without an SQL Event. */
export function nativeReviewObservedFileChanges(
  window: NativeReviewWindowDto,
  prior?: TaskFileChangesResponseDto | null,
): TaskFileChangesResponseDto {
  const byPath = new Map((prior?.items ?? []).map(item => [item.path, item]))
  for (const item of window.observedFileChanges ?? []) {
    const previous = byPath.get(item.path)
    byPath.set(item.path, previous ? {
      ...item,
      firstChangedAt: previous.firstChangedAt < item.firstChangedAt ? previous.firstChangedAt : item.firstChangedAt,
      lastChangedAt: previous.lastChangedAt > item.lastChangedAt ? previous.lastChangedAt : item.lastChangedAt,
      evidence: [...new Set([...previous.evidence, ...item.evidence])],
    } : item)
  }
  // Evidence-only, not an exact Git tree diff; bounded memory even for long sessions.
  const items = [...byPath.values()].slice(0, 64)
  return {
    logicalSessionId: window.sessionId,
    items,
    summary: {
      count: items.length,
      exactCount: 0,
      observedCount: items.length,
    },
    meta: {
      protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
      generatedAt: new Date().toISOString(),
      ...(window.hasMore || window.fileChangesTruncated || byPath.size > items.length
        ? { truncated: true } : {}),
    },
  }
}
