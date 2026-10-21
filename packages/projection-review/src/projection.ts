import type {
  CanonicalObservation,
  SessionSummaryRecord,
  StorageService,
} from '@agent-lens/core'
import {
  SessionProjection,
  type SessionProjectionEntry,
} from '@agent-lens/projection-session'
import { TimelineProjection } from '@agent-lens/projection-timeline'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type ReviewDetailQueryDto,
  type ReviewQueryDto,
  type ReviewResponseDto,
  type ReviewSessionDetailDto,
  type ReviewSessionSummaryDto,
  ToolRegistrationIndex,
  type TimelineItemDto,
} from '@agent-lens/protocol'
import {
  decodeReviewCursor,
  decodeReviewListCursor,
  encodeReviewCursor,
  encodeReviewListCursor,
} from './cursor'
import {
  durationMs,
  highLatencyThreshold,
  InteractionDescriptorStore,
  interactionDescriptorInternals,
  observationError,
} from './interaction-descriptors'
import { ReviewInteractionPager } from './interaction-pagination'
import {
  asRecord,
  buildInteractionGroups,
  buildInteractions,
  buildNodes,
  eventCategory,
  splitInteractionGroups,
  textFromPayload,
} from './nodes'

const MAX_SESSIONS = 500
const DEFAULT_LIMIT = 100
const SLOW_REVIEW_PHASE_MS = 500
const TASK_SESSION_ACTIVITIES = ['user-task', 'branch-task', 'subagent', 'internal-review'] as const

function logSlowReviewPhase(phase: string, startedAt: number, details: Record<string, number | string | boolean> = {}): void {
  const elapsedMs = performance.now() - startedAt
  if (elapsedMs < SLOW_REVIEW_PHASE_MS) return
  console.warn('[AgentLens] Review slow phase', { phase, elapsedMs: Math.round(elapsedMs), ...details })
}

function structuredSessionActivity(value: unknown): ReviewSessionSummaryDto['sessionActivity'] | undefined {
  switch (value) {
    case 'user-task':
    case 'branch-task':
    case 'subagent':
    case 'internal-review':
    case 'system-activity':
      return value
    default:
      return undefined
  }
}

export class ReviewProjection {
  private readonly sessions: SessionProjection
  private readonly timeline: TimelineProjection
  private readonly descriptors: InteractionDescriptorStore
  private readonly pager: ReviewInteractionPager

  constructor(private readonly storage: StorageService) {
    this.sessions = new SessionProjection(storage)
    this.timeline = new TimelineProjection(storage)
    this.descriptors = new InteractionDescriptorStore(storage, this.timeline)
    this.pager = new ReviewInteractionPager(this.timeline, this.descriptors)
  }

  private async summary(entry: SessionProjectionEntry): Promise<ReviewSessionSummaryDto> {
    const { session, logicalSession: logical, observations } = entry
    const project = session.projectId ? await this.storage.repositories.sessions.getProject(session.projectId) : null
    const workspace = session.workspaceId ? await this.storage.repositories.sessions.getWorkspace(session.workspaceId) : null
    const isRealUser = (item: CanonicalObservation): boolean => {
      if (item.kind !== 'message.user') return false
      const provenance = asRecord(asRecord(item.payload).provenance)
      return (provenance.actualAuthor ?? 'human-user') === 'human-user'
        && (provenance.contentRole ?? 'user-request') === 'user-request'
    }
    const firstUser = observations.find(isRealUser)
    const preview = firstUser ? textFromPayload(firstUser.payload) : undefined
    const userTurnCount = observations.filter(isRealUser).length
    const systemContextCount = observations.filter(item => item.kind === 'context.injected').length
    const hasStartupAudit = observations.some(item =>
      item.kind === 'runtime.startup' && asRecord(item.payload).event === 'runtime.startup.audit')
    const lifecycleActivity = observations
      .filter(item => item.kind === 'session.lifecycle')
      .map(item => asRecord(item.payload))
      .find(payload => typeof payload.sessionActivity === 'string')
    const attributedActivity = structuredSessionActivity(lifecycleActivity?.sessionActivity)
    const sessionActivity = attributedActivity && attributedActivity !== 'user-task'
      ? attributedActivity
      : userTurnCount === 0 && (systemContextCount > 0 || hasStartupAudit)
        ? 'system-activity'
        : attributedActivity
    const activitySourceLabel = typeof lifecycleActivity?.activitySourceLabel === 'string'
      ? lifecycleActivity.activitySourceLabel
      : undefined
    const parentSessionId = typeof lifecycleActivity?.parentSessionId === 'string'
      ? lifecycleActivity.parentSessionId
      : undefined
    const toolCount = observations.filter(item => item.kind === 'tool.call').length
    const toolEventCount = observations.filter(item => item.kind.startsWith('tool.') && item.kind !== 'tool.registration').length
    const errorCount = observations.filter(observationError).length
    return {
      id: session.id,
      installationId: session.installationId,
      productId: session.productId,
      sourceIds: session.sourceIds,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      ...(project?.name ? { projectName: project.name } : {}),
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
      ...(workspace?.path ? { workspacePath: workspace.path } : {}),
      ...(logical?.title ? { title: logical.title } : {}),
      ...(logical?.titleKind ? { titleKind: logical.titleKind } : {}),
      ...(preview ? { preview } : {}),
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMs: durationMs(session.startedAt, session.endedAt),
      observationCount: session.observationCount,
      interactionCount: session.interactionCount,
      userTurnCount,
      systemContextCount,
      internalReviewCount: sessionActivity === 'internal-review' ? 1 : 0,
      otherEventCount: Math.max(0, observations.length - userTurnCount - systemContextCount - toolEventCount),
      ...(sessionActivity ? { sessionActivity } : {}),
      ...(activitySourceLabel ? { activitySourceLabel } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      toolCount,
      errorCount,
      hasErrors: errorCount > 0,
    }
  }

  private summaryFromRecord(record: SessionSummaryRecord): ReviewSessionSummaryDto {
    const preview = record.firstUserPayload === undefined
      ? undefined
      : textFromPayload(record.firstUserPayload)
    return {
      id: record.logicalSessionId,
      installationId: record.installationId,
      productId: record.productId,
      sourceIds: record.sourceIds,
      ...(record.projectId ? { projectId: record.projectId } : {}),
      ...(record.projectName ? { projectName: record.projectName } : {}),
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      ...(record.workspacePath ? { workspacePath: record.workspacePath } : {}),
      ...(record.title ? { title: record.title } : {}),
      ...(record.titleKind ? { titleKind: record.titleKind } : {}),
      ...(preview ? { preview } : {}),
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: durationMs(record.startedAt, record.endedAt),
      observationCount: record.observationCount,
      interactionCount: record.interactionCount,
      ...(record.userTurnCount === undefined ? {} : { userTurnCount: record.userTurnCount }),
      ...(record.systemContextCount === undefined ? {} : { systemContextCount: record.systemContextCount }),
      ...(record.internalReviewCount === undefined ? {} : { internalReviewCount: record.internalReviewCount }),
      ...(record.otherEventCount === undefined ? {} : { otherEventCount: record.otherEventCount }),
      ...(record.sessionActivity ? { sessionActivity: record.sessionActivity } : {}),
      ...(record.activitySourceLabel ? { activitySourceLabel: record.activitySourceLabel } : {}),
      ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
      toolCount: record.toolCount,
      errorCount: record.errorCount,
      hasErrors: record.errorCount > 0,
    }
  }

  async query(query: ReviewQueryDto = {}): Promise<ReviewResponseDto> {
    const startedAt = performance.now()
    const requestedLimit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_SESSIONS))
    const cursor = query.cursor ? decodeReviewListCursor(query.cursor) : undefined
    const search = query.search?.trim()
    const sourceIds = query.sourceIds ?? (query.sourceId ? [query.sourceId] : undefined)

    if (this.storage.sessionSummaries) {
      const page = await this.storage.sessionSummaries.query({
        limit: requestedLimit,
        ...(sourceIds !== undefined ? { sourceIds } : {}),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        ...(query.status === 'with-errors' ? { hasErrors: true } : {}),
        ...(query.status === 'clean' ? { hasErrors: false } : {}),
        ...(search ? { search } : {}),
        ...(query.includeSystemActivity ? {} : { sessionActivities: [...TASK_SESSION_ACTIVITIES] }),
        ...(cursor ? { after: cursor } : {}),
      })
      const items = page.items.map(item => this.summaryFromRecord(item))
      const last = items.at(-1)
      const response = {
        items,
        meta: {
          protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
          count: items.length,
          hasMore: page.hasMore,
          ...(page.hasMore && last ? { nextCursor: encodeReviewListCursor({ activeAt: last.endedAt, logicalSessionId: last.id }) } : {}),
          generatedAt: new Date().toISOString(),
        },
      }
      logSlowReviewPhase('list-session-summaries', startedAt, { items: items.length, hasMore: page.hasMore })
      return response
    }

    const summaries = await this.fallbackSummaries()
    const normalizedSearch = search?.toLowerCase()
    const filtered = summaries.filter(item => {
      if (cursor && !(item.endedAt < cursor.activeAt
        || (item.endedAt === cursor.activeAt && item.id > cursor.logicalSessionId))) return false
      if (sourceIds !== undefined && !item.sourceIds.some(sourceId => sourceIds.includes(sourceId))) return false
      if (query.projectId && item.projectId !== query.projectId) return false
      if (query.from && item.endedAt < query.from) return false
      if (query.to && item.endedAt > query.to) return false
      if (query.status === 'with-errors' && !item.hasErrors) return false
      if (query.status === 'clean' && item.hasErrors) return false
      if (!query.includeSystemActivity && item.sessionActivity === 'system-activity') return false
      if (normalizedSearch) {
        const haystack = [item.title, item.preview, item.projectName, item.workspacePath, ...item.sourceIds].filter(Boolean).join('\n').toLowerCase()
        if (!haystack.includes(normalizedSearch)) return false
      }
      return true
    })
    filtered.sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.id.localeCompare(b.id))
    const hasMore = filtered.length > requestedLimit
    const items = filtered.slice(0, requestedLimit)
    const last = items.at(-1)
    const response = {
      items,
      meta: {
        protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
        count: items.length,
        hasMore,
        ...(hasMore && last ? { nextCursor: encodeReviewListCursor({ activeAt: last.endedAt, logicalSessionId: last.id }) } : {}),
        generatedAt: new Date().toISOString(),
      },
    }
    logSlowReviewPhase('list-fallback-summaries', startedAt, { items: items.length, hasMore })
    return response
  }

  private async fallbackSummaries(): Promise<ReviewSessionSummaryDto[]> {
    const raw = await this.sessions.queryEntries({ limit: MAX_SESSIONS })
    return Promise.all(raw.entries.map(item => this.summary(item)))
  }

  private async resolveReadableSession(logicalSessionId: string): Promise<string> {
    const repositories = this.storage.repositories
    const sessions = repositories.sessions
    if (!sessions.listSourceSessionsByLogicalSession) return logicalSessionId
    const sources = await sessions.listSourceSessionsByLogicalSession(logicalSessionId)
    if (!sources.length) return logicalSessionId
    const hasUserMessage = async (id: string): Promise<boolean> => (
      await repositories.observations.query({ logicalSessionId: id, kind: 'message.user', limit: 1 })
    ).length > 0
    const candidates: string[] = []
    const pathIdentity = (value: string): string => {
      const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
      return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
    }
    // 解析器重放可能将共享历史的正文归入另一安装身份。只按原生身份与存储目录
    // 恢复旧链接，不按标题猜测，也不把独立子会话合并。
    for (const source of sources) {
      const installation = await repositories.installations.get(source.installationId)
      if (!installation?.dataRoot) continue
      const peers = await repositories.installations.listByProduct(installation.productId)
      for (const peer of peers) {
        if (peer.id === installation.id || peer.hostId !== installation.hostId || !peer.dataRoot
          || pathIdentity(peer.dataRoot) !== pathIdentity(installation.dataRoot)
          || pathIdentity(peer.configRoot ?? '') !== pathIdentity(installation.configRoot ?? '')) continue
        const candidate = await sessions.findSourceSession(source.sourceId, peer.id, source.nativeSessionId)
        if (!candidate?.logicalSessionId || candidate.runtimeProfileId !== source.runtimeProfileId) continue
        candidates.push(candidate.logicalSessionId)
      }
    }
    // Most sessions have no alternate installation pointing at the same native
    // data root. Avoid an extra observation query on every normal Review page.
    if (candidates.length === 0 || await hasUserMessage(logicalSessionId)) return logicalSessionId
    for (const candidateId of new Set(candidates)) {
      if (await hasUserMessage(candidateId)) return candidateId
    }
    return logicalSessionId
  }

  async getSummary(logicalSessionId: string): Promise<ReviewSessionSummaryDto | null> {
    logicalSessionId = await this.resolveReadableSession(logicalSessionId)
    if (this.storage.sessionSummaries) {
      const result = await this.storage.sessionSummaries.query({
        logicalSessionId,
        limit: 1,
      })
      const record = result.items.find(item => item.logicalSessionId === logicalSessionId)
      return record ? this.summaryFromRecord(record) : null
    }

    const sessionResult = await this.sessions.queryEntries({ logicalSessionId, limit: 1 })
    const session = sessionResult.entries.find(item => item.session.id === logicalSessionId)
    return session ? this.summary(session) : null
  }

  async get(logicalSessionId: string, query: ReviewDetailQueryDto = {}): Promise<ReviewSessionDetailDto | null> {
    logicalSessionId = await this.resolveReadableSession(logicalSessionId)
    const startedAt = performance.now()
    let summary: ReviewSessionSummaryDto | null = null
    if (this.storage.sessionSummaries) {
      const summaryResult = await this.storage.sessionSummaries.query({
        logicalSessionId,
        limit: 1,
      })
      const record = summaryResult.items.find(item => item.logicalSessionId === logicalSessionId)
      if (record) summary = this.summaryFromRecord(record)
    } else {
      const sessionResult = await this.sessions.queryEntries({ logicalSessionId, limit: 1 })
      const session = sessionResult.entries.find(item => item.session.id === logicalSessionId)
      if (session) summary = await this.summary(session)
    }
    if (!summary) {
      logSlowReviewPhase('detail-summary', startedAt, { found: false })
      return null
    }

    const pagerStartedAt = performance.now()
    const result = await this.pager.forQuery(logicalSessionId, query, summary)
    // Registration facts can precede the current page/turn, so an isolated
    // interaction cannot safely recover historical origin.
    const unresolved = query.process !== 'summary' && result.interactions.some(interaction =>
      interaction.nodes.some(node => node.type === 'tool'
        && !node.toolSourceType
        && typeof asRecord(node.payload).runtimeId === 'string'))
    if (unresolved) {
      try {
        const registrations = await this.timeline.query({
        logicalSessionId,
        kind: 'tool.registration',
        direction: 'forward',
        limit: 1000,
      })
      // A truncated register log must not produce a false historical owner.
      if (!registrations.meta.hasMore) {
        const index = new ToolRegistrationIndex(registrations.items)
        for (const interaction of result.interactions) {
          for (const node of interaction.nodes) {
            if (node.type !== 'tool' || node.toolSourceType) continue
            const call = {
              id: node.id,
              kind: 'tool.call' as const,
              installationId: summary.installationId,
              logicalSessionId,
              sourceId: node.sourceId,
              effectiveAt: node.at,
              payload: node.payload,
            } as TimelineItemDto
            const origin = index.resolve(call)
            if (!origin) continue
            node.toolSourceType = origin.toolSourceType
            if (origin.mcpServerId) node.mcpServerId = origin.mcpServerId
            node.registrationObservationId = origin.registrationObservationId
            node.evidence = [...node.evidence, ...origin.evidence]
          }
        }
      }
      } catch (error) {
        // Registration attribution is auxiliary: unavailable evidence must
        // never turn an otherwise readable Review page into HTTP 500.
        console.warn('[AgentLens] Tool registration evidence unavailable', error)
      }
    }
    logSlowReviewPhase('detail-pager', pagerStartedAt, {
      interactions: result.interactions.length,
      filter: query.filter ?? 'all',
      direction: query.direction ?? 'forward',
    })
    const response = {
      ...summary,
      interactions: result.interactions,
      page: result.page,
    }
    logSlowReviewPhase('detail-total', startedAt, {
      interactions: result.interactions.length,
      filter: query.filter ?? 'all',
    })
    return response
  }
}

export const reviewProjectionInternals = {
  textFromPayload,
  buildNodes,
  buildInteractions,
  splitInteractionGroups,
  buildInteractionGroups,
  eventCategory,
  encodeReviewListCursor,
  decodeReviewListCursor,
  encodeReviewCursor,
  decodeReviewCursor,
  highLatencyThreshold,
  maxDescriptorCache: interactionDescriptorInternals.maxDescriptorCache,
}
