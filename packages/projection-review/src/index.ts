import type {
  ObservationCursor,
  SessionSummaryRecord,
  StorageService,
} from '@agent-lens/core'
import type {
  JsonValue,
  ReviewActivityStatus,
  ReviewDetailQueryDto,
  ReviewEventNodeDto,
  ReviewQueryDto,
  ReviewResponseDto,
  ReviewSessionDetailDto,
  ReviewSessionSummaryDto,
} from '@agent-lens/protocol'
import { AGENT_LENS_PROTOCOL_VERSION } from '@agent-lens/protocol'
import {
  ReviewProjection as BaseReviewProjection,
  reviewProjectionInternals as baseReviewProjectionInternals,
} from './projection'

export { HubReviewProjection, hubReviewProjectionInternals } from './hub'

function asRecord(value: JsonValue | unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
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
    const nested = record[key]
    if (nested !== undefined && nested !== value) {
      const text = textFromPayload(nested as JsonValue)
      if (text) return text
    }
  }
  return undefined
}

function durationMs(startedAt: string, endedAt: string): number {
  const value = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function normalizeLifecycleAction(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_:\-]+/g, '.')
}

export function lifecycleEventLabel(payload: JsonValue | unknown): string {
  const record = asRecord(payload)
  const raw = stringField(record, 'event', 'action', 'type', 'status') ?? ''
  const action = normalizeLifecycleAction(raw)

  const exact: Record<string, string> = {
    'session.created': '创建会话',
    'session.create': '创建会话',
    'session.initialized': '会话初始化',
    'session.initialize': '会话初始化',
    'session.started': '会话开始',
    'session.start': '会话开始',
    started: '会话开始',
    start: '会话开始',
    'session.resumed': '恢复会话',
    'session.resume': '恢复会话',
    resumed: '恢复会话',
    resume: '恢复会话',
    'session.continued': '继续会话',
    'session.continue': '继续会话',
    continued: '继续会话',
    continue: '继续会话',
    'session.restarted': '重新开始会话',
    'session.restart': '重新开始会话',
    restarted: '重新开始会话',
    restart: '重新开始会话',
    'session.discovered': '发现会话',
    'session.discover': '发现会话',
    discovered: '发现会话',
    discover: '发现会话',
    'session.paused': '会话暂停',
    'session.pause': '会话暂停',
    paused: '会话暂停',
    pause: '会话暂停',
    'session.interrupted': '会话中断',
    'session.interrupt': '会话中断',
    interrupted: '会话中断',
    interrupt: '会话中断',
    'session.cancelled': '会话取消',
    'session.canceled': '会话取消',
    'session.cancel': '会话取消',
    cancelled: '会话取消',
    canceled: '会话取消',
    cancel: '会话取消',
    'session.aborted': '会话终止',
    'session.abort': '会话终止',
    aborted: '会话终止',
    abort: '会话终止',
    'session.ended': '会话结束',
    'session.end': '会话结束',
    'session.closed': '会话结束',
    'session.close': '会话结束',
    ended: '会话结束',
    end: '会话结束',
    closed: '会话结束',
    close: '会话结束',
    'turn.started': '轮次开始',
    'turn.start': '轮次开始',
    'turn.stopped': '轮次停止',
    'turn.stop': '轮次停止',
    stopped: '轮次停止',
    stop: '轮次停止',
    'turn.ended': '轮次结束',
    'turn.end': '轮次结束',
  }
  if (exact[action]) return exact[action]

  const parts = new Set(action.split('.').filter(Boolean))
  const has = (...values: string[]) => values.some(value => parts.has(value))
  if (has('resume', 'resumed')) return '恢复会话'
  if (has('restart', 'restarted')) return '重新开始会话'
  if (has('continue', 'continued')) return '继续会话'
  if (has('discover', 'discovered')) return '发现会话'
  if (has('initialize', 'initialized', 'init')) return '会话初始化'
  if (has('create', 'created')) return '创建会话'
  if (has('pause', 'paused')) return '会话暂停'
  if (has('interrupt', 'interrupted')) return '会话中断'
  if (has('cancel', 'cancelled', 'canceled')) return '会话取消'
  if (has('abort', 'aborted')) return '会话终止'
  if (parts.has('turn') && has('start', 'started')) return '轮次开始'
  if (parts.has('turn') && has('stop', 'stopped')) return '轮次停止'
  if (parts.has('turn') && has('end', 'ended')) return '轮次结束'
  if (has('start', 'started')) return '会话开始'
  if (has('stop', 'stopped', 'end', 'ended', 'close', 'closed')) return '会话结束'

  return '会话状态变化'
}

function contextEventLabel(node: ReviewEventNodeDto): string {
  const payload = asRecord(node.payload)
  const label = stringField(payload, 'label')
  if (label) return label
  const injectedKind = stringField(payload, 'injectedKind')
  const labels: Record<string, string> = {
    system: 'System',
    developer: 'Developer',
    permissions: '权限策略',
    'runtime-environment': '运行环境',
    agents: 'AGENTS',
    skills: 'Skills',
    plugins: 'Plugins',
    application: '应用注入',
    'transport-echo': '应用上下文',
  }
  return injectedKind ? labels[injectedKind] ?? '系统注入' : '系统注入'
}

function localizeNode(node: ReviewEventNodeDto, sessionActivity?: ReviewSessionSummaryDto['sessionActivity']): ReviewEventNodeDto {
  if (node.kind === 'session.lifecycle') return { ...node, label: lifecycleEventLabel(node.payload) }
  if (node.kind === 'context.injected') return { ...node, label: contextEventLabel(node) }
  if (sessionActivity === 'internal-review' && node.kind === 'permission.request') return { ...node, label: '审查请求' }
  if (sessionActivity === 'internal-review' && node.kind === 'permission.response') return { ...node, label: '审查结果' }
  return node
}

function localizeLifecycle(detail: ReviewSessionDetailDto): ReviewSessionDetailDto {
  return {
    ...detail,
    interactions: detail.interactions.map(interaction => ({
      ...interaction,
      nodes: interaction.nodes.map(node => node.type === 'event'
        ? localizeNode(node, detail.sessionActivity)
        : node),
    })),
  }
}

function summaryFromRecord(record: SessionSummaryRecord): ReviewSessionSummaryDto {
  const preview = record.firstUserPayload === undefined ? undefined : textFromPayload(record.firstUserPayload)
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
    userTurnCount: record.userTurnCount ?? record.interactionCount,
    systemContextCount: record.systemContextCount ?? 0,
    internalReviewCount: record.internalReviewCount ?? 0,
    otherEventCount: record.otherEventCount ?? 0,
    toolCount: record.toolCount,
    errorCount: record.errorCount,
    hasErrors: record.errorCount > 0,
    ...(record.sessionActivity ? { sessionActivity: record.sessionActivity } : {}),
    ...(record.activitySourceLabel ? { activitySourceLabel: record.activitySourceLabel } : {}),
    ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
  }
}

function decodeListCursor(value: string): { startedAt: string; logicalSessionId: string } {
  const parsed = JSON.parse(value) as Record<string, unknown>
  const startedAt = typeof parsed.startedAt === 'string' ? parsed.startedAt : typeof parsed.endedAt === 'string' ? parsed.endedAt : ''
  const logicalSessionId = typeof parsed.logicalSessionId === 'string' ? parsed.logicalSessionId : ''
  if (!startedAt || !logicalSessionId) throw new Error('Invalid review list cursor')
  return { startedAt, logicalSessionId }
}

function encodeListCursor(item: ReviewSessionSummaryDto): string {
  return JSON.stringify({ startedAt: item.startedAt, logicalSessionId: item.id })
}

function observationCursor(item: { id: string; occurredAt?: string; capturedAt: string; canonicalSequence?: number; sourceSequence?: number }): ObservationCursor {
  const sequence = item.canonicalSequence ?? item.sourceSequence
  return {
    effectiveAt: item.occurredAt ?? item.capturedAt,
    ...(sequence === undefined ? {} : { sequence }),
    id: item.id,
  }
}

type SearchMatchSource = NonNullable<ReviewSessionSummaryDto['searchMatchSources']>[number]

async function searchMatchSources(
  storage: StorageService,
  item: ReviewSessionSummaryDto,
  search: string,
): Promise<SearchMatchSource[]> {
  const needle = search.trim().toLowerCase()
  if (!needle) return []
  const matches = new Set<SearchMatchSource>()
  const header = [item.title, item.projectName, item.workspacePath, item.activitySourceLabel, ...item.sourceIds]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  if (header.includes(needle)) matches.add('title')

  let after: ObservationCursor | undefined
  while (true) {
    const page = await storage.repositories.observations.query({
      logicalSessionId: item.id,
      ...(after ? { after } : {}),
      limit: 1000,
    })
    if (!page.length) break
    for (const observation of page) {
      let haystack = ''
      try { haystack = JSON.stringify(observation.payload ?? '').toLowerCase() } catch { haystack = String(observation.payload ?? '').toLowerCase() }
      if (!haystack.includes(needle)) continue
      if (observation.kind === 'message.user') matches.add('user')
      else if (observation.kind === 'context.injected') matches.add('system')
      else if (observation.kind.startsWith('tool.')) matches.add('tool')
      else if (item.sessionActivity === 'internal-review' || observation.kind.startsWith('permission.')) matches.add('review')
      else matches.add('other')
    }
    after = observationCursor(page[page.length - 1]!)
    if (page.length < 1000) break
  }
  return [...matches]
}

function reviewStatus(value: string): ReviewActivityStatus {
  const normalized = value.toLowerCase()
  if (/deny|denied|reject|rejected|refuse|refused|block|blocked/.test(normalized)) return 'denied'
  if (/allow|allowed|approve|approved|grant|granted|accept|accepted/.test(normalized)) return 'allowed'
  if (/error|failed|exception|abort/.test(normalized)) return 'error'
  return 'unknown'
}

async function internalActivityResult(
  storage: StorageService,
  item: ReviewSessionSummaryDto,
): Promise<{ activityResult?: string; activityStatus?: ReviewActivityStatus }> {
  if (item.sessionActivity !== 'internal-review') return {}
  let after: ObservationCursor | undefined
  let result = ''
  while (true) {
    const page = await storage.repositories.observations.query({
      logicalSessionId: item.id,
      ...(after ? { after } : {}),
      limit: 1000,
    })
    if (!page.length) break
    for (const observation of page) {
      if (observation.kind !== 'permission.response') continue
      const payload = asRecord(observation.payload)
      result = stringField(payload, 'decision', 'result', 'status', 'permissionMode', 'permission_mode', 'message')
        ?? textFromPayload(observation.payload)
        ?? result
    }
    after = observationCursor(page[page.length - 1]!)
    if (page.length < 1000) break
  }
  if (result) return { activityResult: result, activityStatus: reviewStatus(result) }
  if (item.errorCount > 0) return { activityResult: '异常', activityStatus: 'error' }
  return { activityResult: '未记录明确结论', activityStatus: 'unknown' }
}

async function enrichSummary(
  storage: StorageService,
  item: ReviewSessionSummaryDto,
  search?: string,
): Promise<void> {
  Object.assign(item, await internalActivityResult(storage, item))
  if (search?.trim()) {
    const sources = await searchMatchSources(storage, item, search)
    if (sources.length) item.searchMatchSources = sources
  }
}

export class ReviewProjection extends BaseReviewProjection {
  constructor(private readonly storageV2: StorageService) {
    super(storageV2)
  }

  override async query(query: ReviewQueryDto = {}): Promise<ReviewResponseDto> {
    if (!this.storageV2.sessionSummaries) return super.query(query)
    const limit = Math.max(1, Math.min(query.limit ?? 100, 500))
    const cursor = query.cursor ? decodeListCursor(query.cursor) : undefined
    const page = await this.storageV2.sessionSummaries.query({
      limit,
      ...(query.sourceId ? { sourceId: query.sourceId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      ...(query.status === 'with-errors' ? { hasErrors: true } : {}),
      ...(query.status === 'clean' ? { hasErrors: false } : {}),
      ...(query.search?.trim() ? { search: query.search.trim() } : {}),
      ...(cursor ? { after: cursor } : {}),
    })
    const items = page.items.map(summaryFromRecord)
    await Promise.all(items.map(item => enrichSummary(this.storageV2, item, query.search)))
    const last = items.at(-1)
    return {
      items,
      meta: {
        protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
        count: items.length,
        hasMore: page.hasMore,
        ...(page.hasMore && last ? { nextCursor: encodeListCursor(last) } : {}),
        generatedAt: new Date().toISOString(),
      },
    }
  }

  override async get(
    logicalSessionId: string,
    query: ReviewDetailQueryDto = {},
  ): Promise<ReviewSessionDetailDto | null> {
    const detail = await super.get(logicalSessionId, query)
    if (!detail) return null
    if (!this.storageV2.sessionSummaries) return localizeLifecycle(detail)
    const page = await this.storageV2.sessionSummaries.query({ logicalSessionId, limit: 1 })
    const record = page.items.find(item => item.logicalSessionId === logicalSessionId)
    const summary = record ? summaryFromRecord(record) : detail
    await enrichSummary(this.storageV2, summary)
    return localizeLifecycle({
      ...detail,
      ...summary,
      interactions: detail.interactions,
      interactionIndex: detail.interactionIndex,
      page: detail.page,
    })
  }
}

export const reviewProjectionInternals = {
  ...baseReviewProjectionInternals,
  lifecycleEventLabel,
  localizeLifecycle,
  contextEventLabel,
  summaryFromRecord,
  searchMatchSources,
  internalActivityResult,
}
