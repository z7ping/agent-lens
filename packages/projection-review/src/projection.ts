import type {
  CanonicalObservation,
  ObservationCursor,
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
  type JsonValue,
  type ReviewDetailDirection,
  type ReviewDetailFilter,
  type ReviewDetailPageDto,
  type ReviewDetailQueryDto,
  type ReviewEventCategory,
  type ReviewEventNodeDto,
  type ReviewInteractionDto,
  type ReviewInteractionIndexDto,
  type ReviewMessageNodeDto,
  type ReviewNodeDto,
  type ReviewNodeSourceDto,
  type ReviewQueryDto,
  type ReviewResponseDto,
  type ReviewSessionDetailDto,
  type ReviewSessionSummaryDto,
  type ReviewToolNodeDto,
  type TimelineItemDto,
} from '@agent-lens/protocol'

const MAX_SESSIONS = 500
const DEFAULT_LIMIT = 100
const DEFAULT_DETAIL_LIMIT = 20
const MAX_DETAIL_LIMIT = 100
const TIMELINE_CHUNK = 250
const DESCRIPTOR_SCAN_CHUNK = 1000

function asRecord(value: JsonValue | unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function stringField(record: Record<string, any>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === 'string' && record[key]) return record[key]
  return undefined
}

function textFromPayload(value: JsonValue | unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.map(textFromPayload).filter((item): item is string => Boolean(item))
    return parts.length ? parts.join('\n') : undefined
  }
  const record = asRecord(value)
  const direct = stringField(record, 'text', 'message', 'content', 'summary', 'prompt')
  if (direct) return direct
  for (const key of ['content', 'message', 'parts']) {
    if (record[key] && record[key] !== value) {
      const nested = textFromPayload(record[key])
      if (nested) return nested
    }
  }
  return undefined
}

function toolCallId(item: TimelineItemDto): string | undefined {
  return stringField(asRecord(item.payload), 'callId', 'call_id', 'toolUseId', 'tool_use_id')
}

function toolName(item: TimelineItemDto): string {
  return stringField(asRecord(item.payload), 'nativeToolName', 'toolName', 'tool_name', 'name') ?? 'Tool'
}

function eventCategory(kind: TimelineItemDto['kind']): ReviewEventCategory {
  if (kind.startsWith('permission.')) return 'permission'
  if (kind.startsWith('subagent.')) return 'subagent'
  if (kind.startsWith('context.')) return 'context'
  if (kind.startsWith('model.')) return 'model'
  if (kind === 'session.lifecycle') return 'lifecycle'
  if (kind === 'artifact.action') return 'artifact'
  if (kind === 'usage') return 'usage'
  return 'unknown'
}

function eventLabel(kind: TimelineItemDto['kind']): string {
  const labels: Partial<Record<TimelineItemDto['kind'], string>> = {
    'session.lifecycle': '会话生命周期',
    'model.call': '模型调用',
    'model.changed': '模型切换',
    'tool.progress': '工具进度',
    'permission.request': '权限请求',
    'permission.response': '权限响应',
    'subagent.spawn': '启动子 Agent',
    'subagent.end': '子 Agent 结束',
    'context.compaction': '上下文压缩',
    'context.summary': '上下文摘要',
    'context.injected': '系统注入上下文',
    'artifact.action': '产物操作',
    usage: '用量',
    unknown: '原始事件',
  }
  return labels[kind] ?? kind
}

function reviewNodeSource(item: TimelineItemDto): ReviewNodeSourceDto {
  return {
    ...(item.nativeEventId ? { nativeEventId: item.nativeEventId } : {}),
    ...(item.nativeParentEventId ? { nativeParentEventId: item.nativeParentEventId } : {}),
    ...(item.parentObservationId ? { parentObservationId: item.parentObservationId } : {}),
    ...(item.occurredAt ? { occurredAt: item.occurredAt } : {}),
    capturedAt: item.capturedAt,
  }
}

function buildNodes(items: TimelineItemDto[]): ReviewNodeDto[] {
  const nodes: ReviewNodeDto[] = []
  const toolsByCallId = new Map<string, ReviewToolNodeDto>()

  for (const item of items) {
    if (item.kind === 'message.user' || item.kind === 'message.assistant' || item.kind === 'message.commentary' || item.kind === 'message.reasoning') {
      const node: ReviewMessageNodeDto = {
        type: 'message', id: item.id,
        role: item.kind === 'message.user'
          ? 'user'
          : item.kind === 'message.commentary'
            ? 'commentary'
          : item.kind === 'message.reasoning'
            ? 'reasoning'
            : 'assistant',
        at: item.effectiveAt, sourceId: item.sourceId, ...reviewNodeSource(item),
        text: textFromPayload(item.payload) ?? '（无可显示文本）', payload: item.payload,
        evidence: item.evidence, observationIds: [item.id],
      }
      nodes.push(node)
      continue
    }

    if (item.kind === 'tool.call') {
      const payload = asRecord(item.payload)
      const id = toolCallId(item)
      const node: ReviewToolNodeDto = {
        type: 'tool', id: item.id, at: item.effectiveAt, sourceId: item.sourceId, ...reviewNodeSource(item),
        name: toolName(item), ...(id ? { callId: id } : {}), status: 'running',
        startedAt: item.effectiveAt,
        ...(payload.input !== undefined ? { input: payload.input as JsonValue } : {}),
        payload: item.payload, evidence: item.evidence, observationIds: [item.id],
      }
      nodes.push(node)
      if (id) toolsByCallId.set(id, node)
      continue
    }

    if (item.kind === 'tool.result') {
      const payload = asRecord(item.payload)
      const id = toolCallId(item)
      const linked = id ? toolsByCallId.get(id) : undefined
      if (linked) {
        linked.endedAt = item.effectiveAt
        linked.status = payload.success === false ? 'error' : payload.success === true ? 'success' : 'unknown'
        const duration = payload.durationMs ?? payload.duration_ms
        if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) linked.durationMs = duration
        if (payload.output !== undefined) linked.output = payload.output as JsonValue
        else if (payload.result !== undefined) linked.output = payload.result as JsonValue
        else linked.output = item.payload
        linked.evidence = [...linked.evidence, ...item.evidence]
        linked.observationIds.push(item.id)
        continue
      }
    }

    const node: ReviewEventNodeDto = {
      type: 'event', id: item.id, at: item.effectiveAt, sourceId: item.sourceId, ...reviewNodeSource(item),
      kind: item.kind, category: eventCategory(item.kind), label: eventLabel(item.kind),
      payload: item.payload, evidence: item.evidence, observationIds: [item.id],
    }
    nodes.push(node)
  }
  return nodes
}

function splitInteractionGroups(items: TimelineItemDto[]): TimelineItemDto[][] {
  const byId = new Map(items.map(item => [item.id, item]))
  const groups: TimelineItemDto[][] = []
  const groupByRoot = new Map<string, TimelineItemDto[]>()
  let linearRoot: string | undefined

  const rootUser = (item: TimelineItemDto): string | undefined => {
    if (item.kind === 'message.user') return item.id
    let current: TimelineItemDto | undefined = item
    const seen = new Set<string>()
    while (current?.parentObservationId && !seen.has(current.parentObservationId)) {
      seen.add(current.parentObservationId)
      current = byId.get(current.parentObservationId)
      if (!current) return undefined
      if (current.kind === 'message.user') return current.id
    }
    return undefined
  }

  for (const item of items) {
    if (item.kind === 'message.user') linearRoot = item.id
    const root = rootUser(item) ?? linearRoot
    if (!root) {
      if (item.kind === 'session.lifecycle') continue
      const background = `background:${item.id}`
      const group = [item]
      groups.push(group)
      groupByRoot.set(background, group)
      continue
    }
    let group = groupByRoot.get(root)
    if (!group) {
      group = []
      groups.push(group)
      groupByRoot.set(root, group)
    }
    group.push(item)
  }
  return groups
}

function buildInteractionGroups(groups: TimelineItemDto[][], startingOrdinal = 1): ReviewInteractionDto[] {
  return groups.map((group, index) => {
    const ordinal = startingOrdinal + index
    return {
      id: `${group[0]!.logicalSessionId}:review:${ordinal}`,
      ordinal,
      trigger: group[0]!.kind === 'message.user' ? 'user' : 'background',
      startedAt: group[0]!.effectiveAt,
      endedAt: group[group.length - 1]!.effectiveAt,
      nodes: buildNodes(group),
    }
  })
}

function buildInteractions(items: TimelineItemDto[], startingOrdinal = 1): ReviewInteractionDto[] {
  return buildInteractionGroups(splitInteractionGroups(items), startingOrdinal)
}

function durationMs(startedAt: string, endedAt: string): number {
  const value = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function observationError(item: CanonicalObservation): boolean {
  if (item.kind !== 'tool.result') return false
  return asRecord(item.payload).success === false
}

function observationEffectiveAt(item: CanonicalObservation): string {
  return item.occurredAt ?? item.capturedAt
}

function observationCursor(item: CanonicalObservation): ObservationCursor {
  const sequence = item.canonicalSequence ?? item.sourceSequence
  return {
    effectiveAt: observationEffectiveAt(item),
    ...(sequence === undefined ? {} : { sequence }),
    id: item.id,
  }
}

type TimelineReviewCursor = {
  mode: 'timeline'
  direction: ReviewDetailDirection
  timelineCursor: string
  ordinal: number
}

type FilterReviewCursor = {
  mode: 'filter'
  filter: Exclude<ReviewDetailFilter, 'all' | 'latest'>
  ordinal: number
}

type ReviewCursorPayload = TimelineReviewCursor | FilterReviewCursor

interface ReviewListCursor {
  startedAt: string
  logicalSessionId: string
}

function encodeReviewListCursor(value: ReviewListCursor): string {
  return JSON.stringify(value)
}

function decodeReviewListCursor(value: string): ReviewListCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Invalid review list cursor')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid review list cursor')
  const record = parsed as Record<string, unknown>
  const startedAt = typeof record.startedAt === 'string' && record.startedAt
    ? record.startedAt
    : typeof record.endedAt === 'string' && record.endedAt
      ? record.endedAt
      : undefined
  if (!startedAt || typeof record.logicalSessionId !== 'string' || !record.logicalSessionId) {
    throw new Error('Invalid review list cursor')
  }
  return { startedAt, logicalSessionId: record.logicalSessionId }
}

function encodeReviewCursor(value: ReviewCursorPayload): string {
  return JSON.stringify(value)
}

function decodeReviewCursor(value: string): ReviewCursorPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Invalid review cursor')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid review cursor')
  const record = parsed as Record<string, unknown>

  if (record.mode === 'filter') {
    if (record.filter !== 'errors' && record.filter !== 'latency') throw new Error('Invalid review cursor')
    if (typeof record.ordinal !== 'number' || !Number.isSafeInteger(record.ordinal) || record.ordinal < 1) {
      throw new Error('Invalid review cursor')
    }
    return { mode: 'filter', filter: record.filter, ordinal: record.ordinal }
  }

  const legacyTimeline = record.mode === undefined && typeof record.timelineCursor === 'string'
  if (record.mode !== 'timeline' && !legacyTimeline) throw new Error('Invalid review cursor')
  if (typeof record.timelineCursor !== 'string' || !record.timelineCursor) throw new Error('Invalid review cursor')
  if (typeof record.ordinal !== 'number' || !Number.isSafeInteger(record.ordinal) || record.ordinal < 1) {
    throw new Error('Invalid review cursor')
  }
  const direction = record.direction === 'backward' ? 'backward' : 'forward'
  return { mode: 'timeline', direction, timelineCursor: record.timelineCursor, ordinal: record.ordinal }
}

interface InteractionDescriptor {
  ordinal: number
  trigger: 'user' | 'background'
  start: ObservationCursor
  end: ObservationCursor
  startedAt: string
  endedAt: string
  hasError: boolean
  preview?: string
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

function highLatencyThreshold(descriptors: InteractionDescriptor[]): number | null {
  const values = descriptors
    .map(item => durationMs(item.startedAt, item.endedAt))
    .filter(value => value > 0)
    .sort((a, b) => a - b)
  if (values.length < 2) return null
  const middle = Math.floor(values.length / 2)
  const median = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2
  const upperIndex = Math.min(values.length - 1, Math.floor((values.length - 1) * 0.75))
  const upperQuartile = values[upperIndex]!
  return Math.max(upperQuartile, median * 1.75)
}

export class ReviewProjection {
  private readonly sessions: SessionProjection
  private readonly timeline: TimelineProjection

  constructor(private readonly storage: StorageService) {
    this.sessions = new SessionProjection(storage)
    this.timeline = new TimelineProjection(storage)
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
      id: session.id, installationId: session.installationId, productId: session.productId,
      sourceIds: session.sourceIds,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      ...(project?.name ? { projectName: project.name } : {}),
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
      ...(workspace?.path ? { workspacePath: workspace.path } : {}),
      ...(logical?.title ? { title: logical.title } : {}),
      ...(preview ? { preview } : {}),
      startedAt: session.startedAt, endedAt: session.endedAt,
      durationMs: durationMs(session.startedAt, session.endedAt),
      observationCount: session.observationCount, interactionCount: session.interactionCount,
      userTurnCount,
      systemContextCount,
      internalReviewCount: sessionActivity === 'internal-review' ? 1 : 0,
      otherEventCount: Math.max(0, observations.length - userTurnCount - systemContextCount - toolEventCount),
      ...(sessionActivity ? { sessionActivity } : {}),
      ...(activitySourceLabel ? { activitySourceLabel } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      toolCount, errorCount, hasErrors: errorCount > 0,
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
          ...(page.hasMore && last ? { nextCursor: encodeReviewListCursor({ startedAt: last.startedAt, logicalSessionId: last.id }) } : {}),
          generatedAt: new Date().toISOString(),
        },
      }
    }

    const summaries = await this.fallbackSummaries()
    const normalizedSearch = search?.toLowerCase()
    const filtered = summaries.filter(item => {
      if (cursor && !(item.startedAt < cursor.startedAt
        || (item.startedAt === cursor.startedAt && item.id > cursor.logicalSessionId))) return false
      if (query.sourceId && !item.sourceIds.includes(query.sourceId)) return false
      if (query.projectId && item.projectId !== query.projectId) return false
      if (query.from && item.startedAt < query.from) return false
      if (query.to && item.startedAt > query.to) return false
      if (query.status === 'with-errors' && !item.hasErrors) return false
      if (query.status === 'clean' && item.hasErrors) return false
      if (normalizedSearch) {
        const haystack = [item.title, item.preview, item.projectName, item.workspacePath, ...item.sourceIds].filter(Boolean).join('\n').toLowerCase()
        if (!haystack.includes(normalizedSearch)) return false
      }
      return true
    })
    filtered.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id))
    const hasMore = filtered.length > requestedLimit
    const items = filtered.slice(0, requestedLimit)
    const last = items.at(-1)
    return {
      items,
      meta: {
        protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
        count: items.length,
        hasMore,
        ...(hasMore && last ? { nextCursor: encodeReviewListCursor({ startedAt: last.startedAt, logicalSessionId: last.id }) } : {}),
        generatedAt: new Date().toISOString(),
      },
    }
  }

  private async fallbackSummaries(): Promise<ReviewSessionSummaryDto[]> {
    const raw = await this.sessions.queryEntries({ limit: MAX_SESSIONS })
    return Promise.all(raw.entries.map(item => this.summary(item)))
  }

  private async scanInteractionDescriptors(logicalSessionId: string): Promise<InteractionDescriptor[]> {
    const descriptors: InteractionDescriptor[] = []
    let after: ObservationCursor | undefined
    let current: InteractionDescriptor | null = null

    const flush = () => {
      if (!current) return
      descriptors.push(current)
      current = null
    }

    while (true) {
      const observations = await this.storage.repositories.observations.query({
        logicalSessionId,
        ...(after ? { after } : {}),
        limit: DESCRIPTOR_SCAN_CHUNK,
      })
      if (!observations.length) break

      for (const observation of observations) {
        if (observation.kind === 'message.user' && current) flush()
        if (!current && observation.kind === 'session.lifecycle') continue
        if (!current) {
          const cursor = observationCursor(observation)
          current = {
            ordinal: descriptors.length + 1,
            trigger: observation.kind === 'message.user' ? 'user' : 'background',
            start: cursor,
            end: cursor,
            startedAt: cursor.effectiveAt,
            endedAt: cursor.effectiveAt,
            hasError: false,
          }
        }
        if (!current.preview && observation.kind === 'message.user') {
          const preview = textFromPayload(observation.payload)?.replace(/\s+/g, ' ').trim()
          if (preview) current.preview = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview
        }
        current.end = observationCursor(observation)
        current.endedAt = observationEffectiveAt(observation)
        current.hasError ||= observationError(observation)
      }

      after = observationCursor(observations[observations.length - 1]!)
      if (observations.length < DESCRIPTOR_SCAN_CHUNK) break
    }
    flush()
    return descriptors
  }

  private async countInteractions(logicalSessionId: string): Promise<number> {
    let userCount = 0
    let after: ObservationCursor | undefined
    while (true) {
      const observations = await this.storage.repositories.observations.query({
        logicalSessionId,
        kind: 'message.user',
        ...(after ? { after } : {}),
        limit: DESCRIPTOR_SCAN_CHUNK,
      })
      if (!observations.length) break
      userCount += observations.length
      after = observationCursor(observations[observations.length - 1]!)
      if (observations.length < DESCRIPTOR_SCAN_CHUNK) break
    }

    let leadingBackground = false
    let probeAfter: ObservationCursor | undefined
    outer: while (true) {
      const probe = await this.storage.repositories.observations.query({
        logicalSessionId,
        ...(probeAfter ? { after: probeAfter } : {}),
        limit: 100,
      })
      if (!probe.length) break
      for (const observation of probe) {
        if (observation.kind === 'session.lifecycle') continue
        leadingBackground = observation.kind !== 'message.user'
        break outer
      }
      probeAfter = observationCursor(probe[probe.length - 1]!)
      if (probe.length < 100) break
    }
    return userCount + (leadingBackground ? 1 : 0)
  }

  private async materializeDescriptor(logicalSessionId: string, descriptor: InteractionDescriptor): Promise<ReviewInteractionDto> {
    const first = await this.storage.repositories.observations.get(descriptor.start.id)
    if (!first) throw new Error(`Review projection integrity error: missing observation ${descriptor.start.id}`)
    const observations: CanonicalObservation[] = [first]
    let after = descriptor.start

    while (observations[observations.length - 1]!.id !== descriptor.end.id) {
      const page = await this.storage.repositories.observations.query({
        logicalSessionId,
        after,
        limit: DESCRIPTOR_SCAN_CHUNK,
      })
      if (!page.length) throw new Error(`Review projection integrity error: incomplete interaction ${descriptor.ordinal}`)
      let found = false
      for (const observation of page) {
        observations.push(observation)
        if (observation.id === descriptor.end.id) {
          found = true
          break
        }
      }
      if (found) break
      after = observationCursor(page[page.length - 1]!)
    }

    const items = await this.timeline.mapObservations(observations)
    const interaction = buildInteractionGroups([items], descriptor.ordinal)[0]
    if (!interaction) throw new Error(`Review projection integrity error: empty interaction ${descriptor.ordinal}`)
    return interaction
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
    const endingOrdinal = decoded?.ordinal ?? knownInteractionCount ?? await this.countInteractions(logicalSessionId)
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
  ): Promise<{ interactions: ReviewInteractionDto[]; page: ReviewDetailPageDto }> {
    const requestedLimit = Math.max(1, Math.min(query.limit ?? DEFAULT_DETAIL_LIMIT, MAX_DETAIL_LIMIT))
    const decoded = query.cursor ? decodeReviewCursor(query.cursor) : null
    if (decoded && (decoded.mode !== 'filter' || decoded.filter !== filter)) throw new Error('Invalid review cursor')
    const afterOrdinal = decoded?.ordinal ?? 0
    const descriptors = await this.scanInteractionDescriptors(logicalSessionId)
    const threshold = filter === 'latency' ? highLatencyThreshold(descriptors) : null
    const matches = descriptors.filter(descriptor => {
      if (descriptor.ordinal <= afterOrdinal) return false
      if (filter === 'errors') return descriptor.hasError
      return threshold !== null && durationMs(descriptor.startedAt, descriptor.endedAt) >= threshold
    })
    const selected = matches.slice(0, requestedLimit)
    const interactions: ReviewInteractionDto[] = []
    for (const descriptor of selected) interactions.push(await this.materializeDescriptor(logicalSessionId, descriptor))
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
    const descriptors = await this.scanInteractionDescriptors(logicalSessionId)

    const filter = query.filter ?? 'all'
    const direction = query.direction ?? 'forward'
    const target = query.ordinal === undefined ? undefined : descriptors.find(item => item.ordinal === query.ordinal)
    const result = query.ordinal !== undefined
      ? {
          interactions: target ? [await this.materializeDescriptor(logicalSessionId, target)] : [],
          page: { count: target ? 1 : 0, hasMore: false, direction: 'forward' as const, filter: 'all' as const },
        }
      : filter === 'errors' || filter === 'latency'
      ? await this.filteredInteractionPage(logicalSessionId, query, filter)
      : filter === 'latest'
        ? await this.backwardInteractionPage(logicalSessionId, { ...query, direction: 'backward' }, 'latest', summary.interactionCount)
        : direction === 'backward'
          ? await this.backwardInteractionPage(logicalSessionId, query, 'all', summary.interactionCount)
          : await this.forwardInteractionPage(logicalSessionId, query)

    return {
      ...summary,
      interactions: result.interactions,
      interactionIndex: descriptors.map((item): ReviewInteractionIndexDto => ({
        id: `${logicalSessionId}:interaction:${item.ordinal}`,
        ordinal: item.ordinal,
        trigger: item.trigger,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
        hasError: item.hasError,
        ...(item.preview ? { preview: item.preview } : {}),
      })),
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
}
