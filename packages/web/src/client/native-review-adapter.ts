import {
  AGENT_LENS_PROTOCOL_VERSION,
  type TaskFileChangesResponseDto,
  type NativeReviewWindowDto,
  type NativeSessionSummaryDto,
  type ReviewSessionDetailDto,
  type ReviewInteractionDto,
} from '@agent-lens/protocol'

/** 原生目录与详情沿用同一标题展示契约，不猜测或重写 Source 的名称。 */
export function nativeReviewTitle(summary: Pick<NativeSessionSummaryDto, 'title' | 'titleProvenance'>) {
  const title = summary.title?.trim()
  return title ? {
    title,
    titleKind: summary.titleProvenance === 'explicit'
      ? 'explicit' as const
      : summary.titleProvenance === 'generated'
        ? 'generated' as const
        : 'unverified' as const,
  } : {}
}

/** Rebuild statistics only from the bounded visible native Review nodes.
 * Original Source candidates can include lifecycle metadata that does not
 * produce a visible node; never promote these counts to full-session SQL totals.
 */
export function nativeVisibleWindowStatistics(interactions: readonly ReviewInteractionDto[]) {
  const sourceObservations = new Set<string>()
  let toolCount = 0
  let errorCount = 0
  for (const interaction of interactions) {
    for (const node of interaction.nodes) {
      for (const id of node.observationIds) sourceObservations.add(id)
      if (node.type === 'tool') {
        toolCount += 1
        if (node.status === 'error') errorCount += 1
      } else if (node.type === 'event' && node.kind === 'session.lifecycle') {
        const payload = node.payload
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          const action = payload.event ?? payload.action
          if (action === 'turn.error' || action === 'assistant.error' || action === 'turn.failed') {
            errorCount += 1
          }
        }
      }
    }
  }
  return {
    observationCount: sourceObservations.size,
    interactionCount: interactions.filter(item => item.trigger === 'user').length,
    toolCount,
    errorCount,
    hasErrors: errorCount > 0,
  }
}

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
  const statistics = nativeVisibleWindowStatistics(interactions)
  const first = interactions[0]?.startedAt ?? summary.lastActivityAt
  const end = summary.lastActivityAt
  const duration = Date.parse(end) - Date.parse(first)
  return {
    id: summary.id,
    sourceIds: [summary.sourceId],
    productId: summary.sourceId,
    installationId: summary.installationId,
    ...nativeReviewTitle(summary),
    ...(summary.projectId?{projectId:summary.projectId}:{}),
    ...(summary.projectName?{projectName:summary.projectName}:{}),
    ...(summary.workspacePath?{workspacePath:summary.workspacePath}:{}),
    startedAt: first,
    endedAt: end,
    durationMs: Number.isFinite(duration) ? Math.max(0, duration) : 0,
    ...statistics,
    // Deliberately not a full SQL SessionSummary. Counts and duration reflect
    // only visible native observations; the header hides total metrics.
    statisticsCompleteness: 'window',
    ...(window.hookEventsTruncated || window.hookFactsPartial
      ? {nativeHookEventsTruncated:true} : {}),
    interactions,
    page: {
      count: interactions.length,
      hasMore: window.hasMore,
      // A complete native EOF is also a valid append-only resume boundary.
      // Keep this Source-owned cursor even when no older turns remain. The
      // regular Load More action still requires hasMore=true; native incremental
      // refresh can resume here without rescanning a long original session.
      nextCursor: window.nextCursor,
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
    ...(current.titleKind ? { titleProvenance: current.titleKind==='unverified'
      ? 'native' as const : current.titleKind } : {}),
    ...(current.projectId?{projectId:current.projectId}:{}),
    ...(current.projectName?{projectName:current.projectName}:{}),
    ...(current.workspacePath?{workspacePath:current.workspacePath}:{}),
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
