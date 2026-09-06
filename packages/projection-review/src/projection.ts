import type {
  CanonicalObservation,
  SessionSummaryRecord,
  StorageService,
} from '@agent-lens/core'
import {
  SessionProjection,
  type SessionProjectionEntry,
} from '@agent-lens/projection-session'
import { TimelineProjection, encodeTimelineCursor } from '@agent-lens/projection-timeline'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type ReviewDetailFilter,
  type ReviewDetailPageDto,
  type ReviewDetailQueryDto,
  type ReviewInteractionDto,
  type ReviewQueryDto,
  type ReviewResponseDto,
  type ReviewSessionDetailDto,
  type ReviewSessionSummaryDto,
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
  type InteractionDescriptor,
} from './interaction-descriptors'
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
const DEFAULT_DETAIL_LIMIT = 20
const MAX_DETAIL_LIMIT = 100
const TIMELINE_CHUNK = 250

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

  constructor(private readonly storage: StorageService) {
    this.sessions = new SessionProjection(storage)
    this.timeline = new TimelineProjection(storage)
    this.descriptors = new InteractionDescriptorStore(storage, this.timeline)
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
    const lifecycleActivity = observations
      .filter(item => item.kind === 'session.lifecycle')
      .map(item => asRecord(item.payload))
      .find(payload => typeof payload.sessionActivity === 'string')
    const attributedActivity = structuredSessionActivity(lifecycleActivity?.sessionActivity)
    const sessionActivity = attributedActivity && attributedActivity !== 'user-task'
      ? attributedActivity
      : userTurnCount === 0 && systemContextCount > 0
        ? 'system-activity'
        : attributedActivity
    const activitySourceLabel = typeof lifecycleActivity?.activitySourceLabel === 'string'
      ? lifecycleActivity.activitySourceLabel
      : undefined
    const parentSessionId = typeof lifecycleActivity?.parentSessionId === 'string'
      ? lifecycleActivity.parentSessionId
      : undefined
    const toolCount = observations.filter(item => item.kind === 'tool.call').length
    const toolEventCount = observations.filter(item => item.kind.startsWith('tool.')).length
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
    const requestedLimit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_SESSIONS))
    const cursor = query.cursor ? decodeReviewListCursor(query.cursor) : undefined
    const search = query.search?.trim()

    if (this.storage.sessionSummaries) {
      const page = await this.storage.sessionSummaries.query({
        limit: requestedLimit,
        ...(query.sourceId ? { sourceId: query.sourceId } : {}),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        ...(query.status === 'with-errors' ? { hasErrors: true } : {}),
        ...(query.status === 'clean' ? { hasErrors: false } : {}),
        ...(search ? { search } : {}),
        ...(cursor ? { after: cursor } : {}),
      })
      const items = page.items.map(item => this.summaryFromRecord(item))
      const last = items.at(-1)
      return {
        items,
        meta: {
          protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
          count: items.length,
          hasMore: page.hasMore,
          ...(page.hasMore && last ? { nextCursor: encodeReviewListCursor({ activeAt: last.endedAt, logicalSessionId: last.id }) } : {}),
          generatedAt: new Date().toISOString(),
        },
      }
    }

    const summaries = await this.fallbackSummaries()
    const normalizedSearch = search?.toLowerCase()
    const filtered = summaries.filter(item => {
      if (cursor && !(item.endedAt < cursor.activeAt
        || (item.endedAt === cursor.activeAt && item.id > cursor.logicalSessionId))) return false
      if (query.sourceId && !item.sourceIds.includes(query.sourceId)) return false
      if (query.projectId && item.projectId !== query.projectId) return false
      if (query.from && item.endedAt < query.from) return false
      if (query.to && item.endedAt > query.to) return false
      if (query.status === 'with-errors' && !item.hasErrors) return false
      if (query.status === 'clean' && item.hasErrors) return false
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
    return {
      items,
      meta: {
        protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
        count: items.length,
        hasMore,
        ...(hasMore && last ? { nextCursor: encodeReviewListCursor({ activeAt: last.endedAt, logicalSessionId: last.id }) } : {}),
        generatedAt: new Date().toISOString(),
      },
    }
  }

  private async fallbackSummaries(): Promise<ReviewSessionSummaryDto[]> {
    const raw = await this.sessions.queryEntries({ limit: MAX_SESSIONS })
    return Promise.all(raw.entries.map(item => this.summary(item)))
  }

  private async forwardInteractionPage(
    logicalSessionId: string,
    query: ReviewDetailQueryDto,
  ): Promise<{ interactions: ReviewInteractionDto[]; page: ReviewDetailPageDto }> {
    const requestedLimit = Math.max(1, Math.min(query.limit ?? DEFAULT_DETAIL_LIMIT, MAX_DETAIL_LIMIT))
    const decoded = query.cursor ? decodeReviewCursor(query.cursor) : null
    if (decoded && (decoded.mode !== 'timeline' || decoded.direction !== 'forward')) throw new Error('Invalid review cursor')
    const startingOrdinal = decoded?.ordinal ?? 1
    let timelineCursor = decoded?.timelineCursor
    let pending: TimelineItemDto[] = []
    const completed: TimelineItemDto[][] = []
    let exhausted = false
    let stoppedAtNextInteraction = false

    while (!exhausted && !stoppedAtNextInteraction && completed.length <= requestedLimit) {
      const page = await this.timeline.query({
        logicalSessionId,
        ...(timelineCursor ? { cursor: timelineCursor } : {}),
        direction: 'forward',
        limit: TIMELINE_CHUNK,
      })

      for (const item of page.items) {
        if (item.kind === 'message.user' && pending.length) {
          completed.push(pending)
          pending = []
          if (completed.length > requestedLimit) {
            stoppedAtNextInteraction = true
            break
          }
        }
        if (!pending.length && item.kind === 'session.lifecycle') continue
        pending.push(item)
      }

      if (stoppedAtNextInteraction) break
      if (!page.meta.hasMore) {
        exhausted = true
        if (pending.length) completed.push(pending)
        pending = []
        break
      }
      if (!page.meta.nextCursor) throw new Error('Timeline pagination integrity error: missing next cursor')
      timelineCursor = page.meta.nextCursor
    }

    const includedGroups = completed.slice(0, requestedLimit)
    const interactions = buildInteractionGroups(includedGroups, startingOrdinal)
    const hasMore = completed.length > requestedLimit || !exhausted || pending.length > 0
    const lastIncluded = includedGroups.at(-1)?.at(-1)
    const nextCursor = hasMore && lastIncluded
      ? encodeReviewCursor({
          mode: 'timeline',
          direction: 'forward',
          timelineCursor: encodeTimelineCursor(lastIncluded),
          ordinal: startingOrdinal + interactions.length,
        })
      : undefined

    return {
      interactions,
      page: {
        count: interactions.length,
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
        direction: 'forward',
        filter: 'all',
      },
    }
  }

  private async backwardInteractionPage(
    logicalSessionId: string,
    query: ReviewDetailQueryDto,
    filter: ReviewDetailFilter = 'all',
    knownInteractionCount?: number,
  ): Promise<{ interactions: ReviewInteractionDto[]; page: ReviewDetailPageDto }> {
    const requestedLimit = filter === 'latest' ? 1 : Math.max(1, Math.min(query.limit ?? DEFAULT_DETAIL_LIMIT, MAX_DETAIL_LIMIT))
    const decoded = query.cursor ? decodeReviewCursor(query.cursor) : null
    if (decoded && (decoded.mode !== 'timeline' || decoded.direction !== 'backward')) throw new Error('Invalid review cursor')
    const endingOrdinal = decoded?.ordinal ?? knownInteractionCount ?? await this.descriptors.count(logicalSessionId)
    if (endingOrdinal < 1) {
      return { interactions: [], page: { count: 0, hasMore: false, direction: 'backward', filter } }
    }

    let timelineCursor = decoded?.timelineCursor
    let pendingDescending: TimelineItemDto[] = []
    const groupsLatestFirst: TimelineItemDto[][] = []
    let exhausted = false

    while (!exhausted && groupsLatestFirst.length < requestedLimit) {
      const page = await this.timeline.query({
        logicalSessionId,
        ...(timelineCursor ? { cursor: timelineCursor } : {}),
        direction: 'backward',
        limit: TIMELINE_CHUNK,
      })
      const descendingItems = [...page.items].reverse()
      for (const item of descendingItems) {
        pendingDescending.push(item)
        if (item.kind === 'message.user') {
          groupsLatestFirst.push([...pendingDescending].reverse())
          pendingDescending = []
          if (groupsLatestFirst.length >= requestedLimit) break
        }
      }

      if (groupsLatestFirst.length >= requestedLimit) break
      if (!page.meta.hasMore) {
        exhausted = true
        if (pendingDescending.length) {
          const chronological = [...pendingDescending].reverse()
          while (chronological[0]?.kind === 'session.lifecycle') chronological.shift()
          if (chronological.length) groupsLatestFirst.push(chronological)
          pendingDescending = []
        }
        break
      }
      if (!page.meta.nextCursor) throw new Error('Timeline pagination integrity error: missing next cursor')
      timelineCursor = page.meta.nextCursor
    }

    const chronologicalGroups = [...groupsLatestFirst].reverse()
    const startingOrdinal = endingOrdinal - chronologicalGroups.length + 1
    const interactions = buildInteractionGroups(chronologicalGroups, startingOrdinal)
    const hasMore = filter === 'latest' ? false : startingOrdinal > 1
    const oldestIncluded = chronologicalGroups[0]?.[0]
    const nextCursor = hasMore && oldestIncluded
      ? encodeReviewCursor({
          mode: 'timeline',
          direction: 'backward',
          timelineCursor: encodeTimelineCursor(oldestIncluded),
          ordinal: startingOrdinal - 1,
        })
      : undefined

    return {
      interactions,
      page: {
        count: interactions.length,
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
        direction: 'backward',
        filter,
      },
    }
  }

  private async filteredInteractionPage(
    logicalSessionId: string,
    query: ReviewDetailQueryDto,
    filter: 'errors' | 'latency',
    descriptors: InteractionDescriptor[],
  ): Promise<{ interactions: ReviewInteractionDto[]; page: ReviewDetailPageDto }> {
    const requestedLimit = Math.max(1, Math.min(query.limit ?? DEFAULT_DETAIL_LIMIT, MAX_DETAIL_LIMIT))
    const decoded = query.cursor ? decodeReviewCursor(query.cursor) : null
    if (decoded && (decoded.mode !== 'filter' || decoded.filter !== filter)) throw new Error('Invalid review cursor')
    const afterOrdinal = decoded?.ordinal ?? 0
    const threshold = filter === 'latency' ? highLatencyThreshold(descriptors) : null
    const matches = descriptors.filter(descriptor => {
      if (descriptor.ordinal <= afterOrdinal) return false
      if (filter === 'errors') return descriptor.hasError
      return threshold !== null && durationMs(descriptor.startedAt, descriptor.endedAt) >= threshold
    })
    const selected = matches.slice(0, requestedLimit)
    const interactions: ReviewInteractionDto[] = []
    for (const descriptor of selected) interactions.push(await this.descriptors.materialize(logicalSessionId, descriptor))
    const hasMore = matches.length > requestedLimit
    const last = selected.at(-1)
    const nextCursor = hasMore && last
      ? encodeReviewCursor({ mode: 'filter', filter, ordinal: last.ordinal })
      : undefined

    return {
      interactions,
      page: {
        count: interactions.length,
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
        direction: 'forward',
        filter,
        ...(threshold === null ? {} : { latencyThresholdMs: threshold }),
      },
    }
  }

  async get(logicalSessionId: string, query: ReviewDetailQueryDto = {}): Promise<ReviewSessionDetailDto | null> {
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
    if (!summary) return null

    const filter = query.filter ?? 'all'
    const direction = query.direction ?? 'forward'
    let result: { interactions: ReviewInteractionDto[]; page: ReviewDetailPageDto }

    if (query.ordinal !== undefined) {
      const target = await this.descriptors.find(logicalSessionId, query.ordinal)
      result = {
        interactions: target ? [await this.descriptors.materialize(logicalSessionId, target)] : [],
        page: { count: target ? 1 : 0, hasMore: false, direction: 'forward', filter: 'all' },
      }
    } else if (filter === 'errors' || filter === 'latency') {
      const descriptors = await this.descriptors.cached(summary)
      result = await this.filteredInteractionPage(logicalSessionId, query, filter, descriptors)
    } else if (filter === 'latest') {
      result = await this.backwardInteractionPage(
        logicalSessionId,
        { ...query, direction: 'backward' },
        'latest',
        summary.interactionCount > 0 ? summary.interactionCount : undefined,
      )
    } else if (direction === 'backward') {
      result = await this.backwardInteractionPage(
        logicalSessionId,
        query,
        'all',
        summary.interactionCount > 0 ? summary.interactionCount : undefined,
      )
    } else {
      result = await this.forwardInteractionPage(logicalSessionId, query)
    }

    return {
      ...summary,
      interactions: result.interactions,
      page: result.page,
    }
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
