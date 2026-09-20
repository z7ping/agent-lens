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
// Evidence rows can be larger than their observation headers (and may have
// multiple parser versions). Keep the foreground materialisation batch below
// the per-interaction display window so a normal page stays within the reader
// budget instead of merely moving the old timeout to the next cursor page.
const MAX_PAGE_OBSERVATIONS = 240
const SLOW_REVIEW_PAGER_MS = 500

function logSlowReviewPager(startedAt: number, mode: string, page: ReviewInteractionPage): void {
  const elapsedMs = performance.now() - startedAt
  if (elapsedMs < SLOW_REVIEW_PAGER_MS) return
  console.warn('[AgentLens] Review pager slow phase', {
    mode,
    elapsedMs: Math.round(elapsedMs),
    interactions: page.interactions.length,
    hasMore: page.page.hasMore,
  })
}

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

  private async forwardFromOrdinal(
    logicalSessionId: string,
    query: ReviewDetailQueryDto,
    summary: ReviewSessionSummaryDto,
    startingOrdinal: number,
  ): Promise<ReviewInteractionPage> {
    const limit = requestedLimit(query)
    const descriptors = await this.descriptors.structureCached(summary)
    const candidates = descriptors.filter(item => item.ordinal >= startingOrdinal)
    const selected: InteractionDescriptor[] = []
    let observationCount = 0
    for (const descriptor of candidates) {
      if (selected.length >= limit) break
      // Keep an oversized interaction reachable. Its existing 600-node head/tail
      // contract is still applied by ReviewProjection after materialisation.
      if (selected.length > 0 && observationCount + descriptor.observationCount > MAX_PAGE_OBSERVATIONS) break
      selected.push(descriptor)
      observationCount += descriptor.observationCount
    }

    const interactions = await this.descriptors.materializeMany(logicalSessionId, selected)
    const last = selected.at(-1)
    const hasMore = Boolean(last && candidates.length > selected.length)
    const nextCursor = hasMore && last
      ? encodeReviewCursor({
          mode: 'timeline',
          direction: 'forward',
          timelineCursor: encodeTimelineCursor({
            id: last.end.id,
            effectiveAt: last.end.effectiveAt,
            ...(last.end.sequence === undefined ? {} : { canonicalSequence: last.end.sequence }),
          }),
          ordinal: last.ordinal + 1,
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

  private async forwardBounded(
    logicalSessionId: string,
    query: ReviewDetailQueryDto,
    summary: ReviewSessionSummaryDto,
  ): Promise<ReviewInteractionPage> {
    const decoded = query.cursor ? decodeReviewCursor(query.cursor) : null
    if (decoded && (decoded.mode !== 'timeline' || decoded.direction !== 'forward')) throw new Error('Invalid review cursor')
    return this.forwardFromOrdinal(logicalSessionId, query, summary, decoded?.ordinal ?? 1)
  }

  async backward(
    logicalSessionId: string,
    query: ReviewDetailQueryDto,
    filter: ReviewDetailFilter = 'all',
  ): Promise<ReviewInteractionPage> {
    const limit = requestedLimit(query, filter === 'latest' ? 1 : undefined)
    const decoded = query.cursor ? decodeReviewCursor(query.cursor) : null
    if (decoded && (decoded.mode !== 'timeline' || decoded.direction !== 'backward')) throw new Error('Invalid review cursor')
    // Review interaction ordinals include all message.user boundaries plus a possible
    // leading background round. SessionSummary.interactionCount is intentionally only
    // the real human-user turn count, so it cannot be used as the Review ordinal tail.
    const endingOrdinal = decoded?.ordinal ?? await this.descriptors.count(logicalSessionId)
    if (endingOrdinal < 1) {
      return { interactions: [], page: { count: 0, hasMore: false, direction: 'backward', filter } }
    }

    let timelineCursor = decoded?.timelineCursor
    let pendingDescending: TimelineItemDto[] = []
    const groupsLatestFirst: TimelineItemDto[][] = []
    let exhausted = false
    let reachedObservationBudget = false
    let scannedObservations = 0

    while (!exhausted && !reachedObservationBudget && groupsLatestFirst.length < limit) {
      const page = await this.timeline.query({
        logicalSessionId,
        ...(timelineCursor ? { cursor: timelineCursor } : {}),
        direction: 'backward',
        limit: TIMELINE_CHUNK,
      })
      for (const item of [...page.items].reverse()) {
        pendingDescending.push(item)
        scannedObservations += 1
        if (item.kind === 'message.user') {
          groupsLatestFirst.push([...pendingDescending].reverse())
          pendingDescending = []
          if (groupsLatestFirst.length >= limit) break
        }
        // A background-only tail can otherwise make a normal backward page scan
        // an unbounded session looking for a user boundary. Return this bounded
        // group with a cursor so the next page can continue from its oldest item.
        if (scannedObservations >= MAX_PAGE_OBSERVATIONS) {
          if (pendingDescending.length) {
            groupsLatestFirst.push([...pendingDescending].reverse())
            pendingDescending = []
          }
          reachedObservationBudget = true
          break
        }
      }

      if (groupsLatestFirst.length >= limit || reachedObservationBudget) break
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
    const hasMore = filter === 'latest' ? false : reachedObservationBudget || startingOrdinal > 1
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
    const interactions = await this.descriptors.materializeMany(logicalSessionId, selected)
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

  private async summaryForQuery(
    logicalSessionId: string,
    query: ReviewDetailQueryDto,
    summary: ReviewSessionSummaryDto,
  ): Promise<ReviewInteractionPage> {
    const descriptors = await this.descriptors.structureCached(summary)
    const filter = query.filter ?? 'all'

    if (query.ordinal !== undefined) {
      const target = descriptors.find(item => item.ordinal === query.ordinal)
      const interactions = target
        ? await this.descriptors.materializeSummaryMany(logicalSessionId, [target])
        : []
      return {
        interactions,
        page: { count: interactions.length, hasMore: false, direction: 'forward', filter: 'all' },
      }
    }

    const boundedForward = (candidates: readonly InteractionDescriptor[], limit: number): InteractionDescriptor[] => {
      const selected: InteractionDescriptor[] = []
      let observationCount = 0
      for (const descriptor of candidates) {
        if (selected.length >= limit) break
        if (selected.length > 0 && observationCount + descriptor.observationCount > MAX_PAGE_OBSERVATIONS) break
        selected.push(descriptor)
        observationCount += descriptor.observationCount
      }
      return selected
    }

    if (query.afterOrdinal !== undefined) {
      const limit = requestedLimit(query)
      const candidates = descriptors.filter(item => item.ordinal >= query.afterOrdinal!)
      const selected = boundedForward(candidates, limit)
      const interactions = await this.descriptors.materializeSummaryMany(logicalSessionId, selected)
      const last = selected.at(-1)
      const hasMore = Boolean(last && candidates.length > selected.length)
      const nextCursor = hasMore && last
        ? encodeReviewCursor({
            mode: 'timeline',
            direction: 'forward',
            timelineCursor: encodeTimelineCursor({
              id: last.end.id,
              effectiveAt: last.end.effectiveAt,
              ...(last.end.sequence === undefined ? {} : { canonicalSequence: last.end.sequence }),
            }),
            ordinal: last.ordinal + 1,
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

    if (filter === 'errors' || filter === 'latency') {
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
      const interactions = await this.descriptors.materializeSummaryMany(logicalSessionId, selected)
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

    const direction = filter === 'latest' ? 'backward' : (query.direction ?? 'forward')
    if (direction === 'backward') {
      const limit = requestedLimit(query, filter === 'latest' ? 1 : undefined)
      const decoded = query.cursor ? decodeReviewCursor(query.cursor) : null
      if (decoded && (decoded.mode !== 'timeline' || decoded.direction !== 'backward')) throw new Error('Invalid review cursor')
      const endingOrdinal = decoded?.ordinal ?? descriptors.at(-1)?.ordinal ?? 0
      const candidates = descriptors.filter(item => item.ordinal <= endingOrdinal)
      const selected = candidates.slice(-limit)
      const interactions = await this.descriptors.materializeSummaryMany(logicalSessionId, selected)
      const first = selected[0]
      const hasMore = filter === 'latest' ? false : Boolean(first && first.ordinal > 1)
      const nextCursor = hasMore && first
        ? encodeReviewCursor({
            mode: 'timeline',
            direction: 'backward',
            timelineCursor: encodeTimelineCursor({
              id: first.start.id,
              effectiveAt: first.start.effectiveAt,
              ...(first.start.sequence === undefined ? {} : { canonicalSequence: first.start.sequence }),
            }),
            ordinal: first.ordinal - 1,
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

    const limit = requestedLimit(query)
    const decoded = query.cursor ? decodeReviewCursor(query.cursor) : null
    if (decoded && (decoded.mode !== 'timeline' || decoded.direction !== 'forward')) throw new Error('Invalid review cursor')
    const startingOrdinal = decoded?.ordinal ?? 1
    const candidates = descriptors.filter(item => item.ordinal >= startingOrdinal)
    const selected = boundedForward(candidates, limit)
    const interactions = await this.descriptors.materializeSummaryMany(logicalSessionId, selected)
    const last = selected.at(-1)
    const hasMore = Boolean(last && candidates.length > selected.length)
    const nextCursor = hasMore && last
      ? encodeReviewCursor({
          mode: 'timeline',
          direction: 'forward',
          timelineCursor: encodeTimelineCursor({
            id: last.end.id,
            effectiveAt: last.end.effectiveAt,
            ...(last.end.sequence === undefined ? {} : { canonicalSequence: last.end.sequence }),
          }),
          ordinal: last.ordinal + 1,
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

  async forQuery(
    logicalSessionId: string,
    query: ReviewDetailQueryDto,
    summary: ReviewSessionSummaryDto,
  ): Promise<ReviewInteractionPage> {
    const startedAt = performance.now()
    if (query.process === 'summary') {
      const result = await this.summaryForQuery(logicalSessionId, query, summary)
      logSlowReviewPager(startedAt, `summary-${query.filter ?? query.direction ?? 'forward'}`, result)
      return result
    }

    let mode = 'forward'
    let result: ReviewInteractionPage
    if (query.ordinal !== undefined) {
      const descriptors = await this.descriptors.structureCached(summary)
      const target = descriptors.find(item => item.ordinal === query.ordinal)
      result = {
        interactions: target ? [await this.descriptors.materialize(logicalSessionId, target)] : [],
        page: { count: target ? 1 : 0, hasMore: false, direction: 'forward', filter: 'all' },
      }
      mode = 'ordinal'
    } else if (query.afterOrdinal !== undefined) {
      result = await this.forwardFromOrdinal(
        logicalSessionId,
        { ...query, direction: 'forward' },
        summary,
        query.afterOrdinal,
      )
      mode = 'tail'
    } else {
      const filter = query.filter ?? 'all'
      if (filter === 'errors' || filter === 'latency') {
        result = await this.filtered(logicalSessionId, query, filter, await this.descriptors.cached(summary))
        mode = filter
      } else if (filter === 'latest') {
        result = await this.backward(
          logicalSessionId,
          { ...query, direction: 'backward' },
          'latest',
        )
        mode = 'latest'
      } else if ((query.direction ?? 'forward') === 'backward') {
        result = await this.backward(
          logicalSessionId,
          query,
          'all',
        )
        mode = 'backward'
      } else {
        result = await this.forwardBounded(logicalSessionId, query, summary)
      }
    }
    logSlowReviewPager(startedAt, mode, result)
    return result
  }
}
