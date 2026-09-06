import { encodeTimelineCursor, type TimelineProjection } from '@agent-lens/projection-timeline'
import type {
  ReviewDetailFilter,
  ReviewDetailPageDto,
  ReviewDetailQueryDto,
  ReviewInteractionDto,
  ReviewSessionSummaryDto,
  TimelineItemDto,
} from '@agent-lens/protocol'
import { decodeReviewCursor, encodeReviewCursor } from './cursor'
import {
  durationMs,
  highLatencyThreshold,
  type InteractionDescriptor,
  type InteractionDescriptorStore,
} from './interaction-descriptors'
import { buildInteractionGroups } from './nodes'

const DEFAULT_DETAIL_LIMIT = 20
const MAX_DETAIL_LIMIT = 100
const TIMELINE_CHUNK = 250

type ReviewInteractionPage = {
  interactions: ReviewInteractionDto[]
  page: ReviewDetailPageDto
}

function requestedLimit(query: ReviewDetailQueryDto, override?: number): number {
  return override ?? Math.max(1, Math.min(query.limit ?? DEFAULT_DETAIL_LIMIT, MAX_DETAIL_LIMIT))
}

export class ReviewInteractionPager {
  constructor(
    private readonly timeline: TimelineProjection,
    private readonly descriptors: InteractionDescriptorStore,
  ) {}

  async forward(logicalSessionId: string, query: ReviewDetailQueryDto): Promise<ReviewInteractionPage> {
    const limit = requestedLimit(query)
    const decoded = query.cursor ? decodeReviewCursor(query.cursor) : null
    if (decoded && (decoded.mode !== 'timeline' || decoded.direction !== 'forward')) throw new Error('Invalid review cursor')
    const startingOrdinal = decoded?.ordinal ?? 1
    let timelineCursor = decoded?.timelineCursor
    let pending: TimelineItemDto[] = []
    const completed: TimelineItemDto[][] = []
    let exhausted = false
    let stoppedAtNextInteraction = false

    while (!exhausted && !stoppedAtNextInteraction && completed.length <= limit) {
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
          if (completed.length > limit) {
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

    const includedGroups = completed.slice(0, limit)
    const interactions = buildInteractionGroups(includedGroups, startingOrdinal)
    const hasMore = completed.length > limit || !exhausted || pending.length > 0
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

  async backward(
    logicalSessionId: string,
    query: ReviewDetailQueryDto,
    filter: ReviewDetailFilter = 'all',
    knownInteractionCount?: number,
  ): Promise<ReviewInteractionPage> {
    const limit = requestedLimit(query, filter === 'latest' ? 1 : undefined)
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

    while (!exhausted && groupsLatestFirst.length < limit) {
      const page = await this.timeline.query({
        logicalSessionId,
        ...(timelineCursor ? { cursor: timelineCursor } : {}),
        direction: 'backward',
        limit: TIMELINE_CHUNK,
      })
      for (const item of [...page.items].reverse()) {
        pendingDescending.push(item)
        if (item.kind === 'message.user') {
          groupsLatestFirst.push([...pendingDescending].reverse())
          pendingDescending = []
          if (groupsLatestFirst.length >= limit) break
        }
      }

      if (groupsLatestFirst.length >= limit) break
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

  async filtered(
    logicalSessionId: string,
    query: ReviewDetailQueryDto,
    filter: 'errors' | 'latency',
    descriptors: InteractionDescriptor[],
  ): Promise<ReviewInteractionPage> {
    const limit = requestedLimit(query)
    const decoded = query.cursor ? decodeReviewCursor(query.cursor) : null
    if (decoded && (decoded.mode !== 'filter' || decoded.filter !== filter)) throw new Error('Invalid review cursor')
    const afterOrdinal = decoded?.ordinal ?? 0
    const threshold = filter === 'latency' ? highLatencyThreshold(descriptors) : null
    const matches = descriptors.filter(descriptor => {
      if (descriptor.ordinal <= afterOrdinal) return false
      if (filter === 'errors') return descriptor.hasError
      return threshold !== null && durationMs(descriptor.startedAt, descriptor.endedAt) >= threshold
    })
    const selected = matches.slice(0, limit)
    const interactions: ReviewInteractionDto[] = []
    for (const descriptor of selected) interactions.push(await this.descriptors.materialize(logicalSessionId, descriptor))
    const hasMore = matches.length > limit
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

  async forQuery(
    logicalSessionId: string,
    query: ReviewDetailQueryDto,
    summary: ReviewSessionSummaryDto,
  ): Promise<ReviewInteractionPage> {
    if (query.ordinal !== undefined) {
      const target = await this.descriptors.find(logicalSessionId, query.ordinal)
      return {
        interactions: target ? [await this.descriptors.materialize(logicalSessionId, target)] : [],
        page: { count: target ? 1 : 0, hasMore: false, direction: 'forward', filter: 'all' },
      }
    }

    const filter = query.filter ?? 'all'
    if (filter === 'errors' || filter === 'latency') {
      return this.filtered(logicalSessionId, query, filter, await this.descriptors.cached(summary))
    }
    if (filter === 'latest') {
      return this.backward(
        logicalSessionId,
        { ...query, direction: 'backward' },
        'latest',
        summary.interactionCount > 0 ? summary.interactionCount : undefined,
      )
    }
    if ((query.direction ?? 'forward') === 'backward') {
      return this.backward(
        logicalSessionId,
        query,
        'all',
        summary.interactionCount > 0 ? summary.interactionCount : undefined,
      )
    }
    return this.forward(logicalSessionId, query)
  }
}

export const interactionPaginationInternals = {
  defaultDetailLimit: DEFAULT_DETAIL_LIMIT,
  maxDetailLimit: MAX_DETAIL_LIMIT,
  timelineChunk: TIMELINE_CHUNK,
}
