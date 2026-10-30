import {
  AGENT_LENS_PROTOCOL_VERSION,
  type TaskFileChangesResponseDto,
  type NativeReviewWindowDto,
  type NativeSessionSummaryDto,
  type ReviewSessionDetailDto,
  type ReviewInteractionDto,
  type ReviewNodeDto,
  type ReviewToolNodeDto,
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

/** 原生窗口与失败样本共用明确错误判据，包含跨窗口尚未配对的工具结果。 */
export function nativeReviewNodeIsFailure(node: ReviewNodeDto): boolean {
  if(node.type==='tool')return node.status==='error'
  if(node.type!=='event'||!node.payload||typeof node.payload!=='object'||Array.isArray(node.payload))return false
  const payload=node.payload
  if(node.kind==='tool.result')return payload.success===false||payload.status==='error'||payload.isError===true
  if(node.kind!=='session.lifecycle')return false
  const action=payload.event??payload.action
  return action==='turn.error'||action==='assistant.error'||action==='turn.failed'
}

/** 只统计已加载窗口，不能将窗口数值宣称为完整会话总量。 */
export function nativeVisibleWindowStatistics(interactions: readonly ReviewInteractionDto[]) {
  const sourceObservations = new Set<string>()
  let toolCount = 0
  let errorCount = 0
  for (const interaction of interactions) {
    for (const node of interaction.nodes) {
      for (const id of node.observationIds) sourceObservations.add(id)
      if(nativeReviewNodeIsFailure(node))errorCount+=1
      if (node.type === 'tool') {
        toolCount += 1
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


const MAX_NATIVE_TURN_NODES = 512

/** Reconcile only explicit, same-source call IDs when a tool result arrives
 * in another bounded fragment. Never infer a pairing from time or text. */
function mergeNativeTurn(previous: ReviewInteractionDto, incoming: ReviewInteractionDto): ReviewInteractionDto {
  if (previous.id !== incoming.id || previous.ordinal !== incoming.ordinal
    || previous.trigger !== 'user' || incoming.trigger !== 'user') {
    throw new Error('Native turn fragment identity changed')
  }
  const nodes: ReviewNodeDto[] = []
  const seen = new Set<string>()
  const tools = new Map<string, ReviewToolNodeDto>()
  const scoped = (sourceId: string, callId: string) => JSON.stringify([sourceId, callId])
  for (const raw of [...previous.nodes, ...incoming.nodes]) {
    if (seen.has(raw.id)) continue
    seen.add(raw.id)
    const node: ReviewNodeDto = { ...raw, evidence: [...raw.evidence], observationIds: [...raw.observationIds] }
    if (node.type === 'event' && node.kind === 'tool.result') {
      const payload = node.payload && typeof node.payload === 'object' && !Array.isArray(node.payload)
        ? node.payload : {}
      const callId = node.nativeCallId ?? (['callId','call_id','toolUseId','tool_use_id']
        .map(key => payload[key]).find(value => typeof value === 'string' && value) as string | undefined)
      const linked = callId ? tools.get(scoped(node.sourceId, callId)) : undefined
      if (linked) {
        linked.endedAt = node.at
        linked.status = payload.success === false ? 'error' : payload.success === true ? 'success' : 'unknown'
        const duration = payload.durationMs ?? payload.duration_ms
        if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) linked.durationMs = duration
        linked.output = payload.output ?? payload.result ?? node.payload
        linked.evidence = [...new Map([...linked.evidence, ...node.evidence].map(item => [item.id, item])).values()]
        linked.observationIds = [...new Set([...linked.observationIds, ...node.observationIds])]
        continue
      }
    }
    if (node.type === 'tool' && node.callId) tools.set(scoped(node.sourceId, node.callId), node)
    nodes.push(node)
  }
  const omitted = (previous.omittedNodeCount ?? 0) + Math.max(0, nodes.length - MAX_NATIVE_TURN_NODES)
  // Keep the actual user prompt in the visible window so the Turn Rail never
  // loses its preview when thousands of tool events arrive.
  const firstUser = nodes.find(node => node.type === 'message' && node.role === 'user')
  const tail = nodes.slice(-(MAX_NATIVE_TURN_NODES - (firstUser ? 1 : 0)))
  const visible = firstUser && !tail.some(node => node.id === firstUser.id)
    ? [firstUser, ...tail] : nodes.slice(-MAX_NATIVE_TURN_NODES)
  return {
    ...previous,
    endedAt: incoming.endedAt,
    ...(previous.observationRange && incoming.observationRange
      ? {observationRange: {firstId: previous.observationRange.firstId,
          lastId: incoming.observationRange.lastId}} : {}),
    nodes: visible,
    ...(omitted ? {
      nodesTruncated: true,
      omittedNodeCount: omitted,
      totalNodeCount: omitted + visible.length,
    } : {}),
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
  if (window.state !== 'available'
    || (window.boundaryIntegrity !== 'complete'
      && !(window.boundaryIntegrity === 'partial' && window.turnFragment === 'partial'))
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
    ...(window.turnFragment === 'partial' ? {nativeTurnIncomplete:true} : {}),
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
  const next = nativeReviewDetail({
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
  const previous = new Map(current.interactions.map(item => [item.id, item]))
  return {
    ...next,
    interactions: next.interactions.map(item => {
      const existing = previous.get(item.id)
      return existing ? mergeNativeTurn(existing, item) : item
    }),
  }
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
