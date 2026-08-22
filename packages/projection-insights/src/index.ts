import type {
  CanonicalObservation,
  ObservationCursor,
  SessionSummaryRecord,
  SourceSession,
  StorageService,
} from '@agent-lens/core'
import { ToolAssetUsageProjection } from '@agent-lens/projection-usage'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type InsightAgentUsageDto,
  type InsightMetricDeltaDto,
  type InsightMetricSetDto,
  type InsightTrendPointDto,
  type InsightWorkflowPatternDto,
  type InsightsQueryDto,
  type InsightsResponseDto,
} from '@agent-lens/protocol'

const SESSION_SAMPLE_LIMIT = 500
const FALLBACK_OBSERVATION_LIMIT = 5000
const OBSERVATION_SCAN_CHUNK = 1000
const WORKFLOW_PATTERN_MINIMUM_SESSIONS = 5
const MAX_WORKFLOW_PATTERNS = 8
const MAX_PATTERN_OBSERVATIONS = 24

interface SessionLoadResult {
  items: SessionSummaryRecord[]
  sampled: boolean
}

function effectiveAt(item: CanonicalObservation): string {
  return item.occurredAt ?? item.capturedAt
}

function observationCursor(item: CanonicalObservation): ObservationCursor {
  const sequence = item.canonicalSequence ?? item.sourceSequence
  return {
    effectiveAt: effectiveAt(item),
    ...(sequence === undefined ? {} : { sequence }),
    id: item.id,
  }
}

function durationMs(startedAt: string, endedAt: string): number {
  const value = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function emptyMetrics(): InsightMetricSetDto {
  return {
    sessionCount: 0,
    interactionCount: 0,
    toolCallCount: 0,
    errorCount: 0,
    totalDurationMs: 0,
  }
}

function addSession(metrics: InsightMetricSetDto, session: SessionSummaryRecord): void {
  metrics.sessionCount += 1
  metrics.interactionCount += session.interactionCount
  metrics.toolCallCount += session.toolCount
  metrics.errorCount += session.errorCount
  metrics.totalDurationMs += durationMs(session.startedAt, session.endedAt)
}

function metricsFor(sessions: SessionSummaryRecord[]): InsightMetricSetDto {
  const metrics = emptyMetrics()
  for (const session of sessions) addSession(metrics, session)
  return metrics
}

function percentDelta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null
  return Math.round(((current - previous) / previous) * 1000) / 10
}

function metricDelta(current: InsightMetricSetDto, previous: InsightMetricSetDto): InsightMetricDeltaDto {
  return {
    sessionCountPercent: percentDelta(current.sessionCount, previous.sessionCount),
    interactionCountPercent: percentDelta(current.interactionCount, previous.interactionCount),
    toolCallCountPercent: percentDelta(current.toolCallCount, previous.toolCallCount),
    errorCountPercent: percentDelta(current.errorCount, previous.errorCount),
    totalDurationMsPercent: percentDelta(current.totalDurationMs, previous.totalDurationMs),
  }
}

function matchesScope(session: SessionSummaryRecord, query: InsightsQueryDto): boolean {
  if (query.sourceId && !session.sourceIds.includes(query.sourceId)) return false
  if (query.projectId && session.projectId !== query.projectId) return false
  if (query.from && session.endedAt < query.from) return false
  if (query.to && session.startedAt > query.to) return false
  return true
}

function trendFor(sessions: SessionSummaryRecord[], query: InsightsQueryDto): InsightTrendPointDto[] {
  const buckets = new Map<string, InsightTrendPointDto>()
  for (const session of sessions) {
    const date = session.endedAt.slice(0, 10)
    let bucket = buckets.get(date)
    if (!bucket) {
      bucket = { date, ...emptyMetrics() }
      buckets.set(date, bucket)
    }
    addSession(bucket, session)
  }

  const fromMs = query.from ? Date.parse(query.from) : Number.NaN
  const toMs = query.to ? Date.parse(query.to) : Date.now()
  if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs >= fromMs) {
    const days = Math.floor((toMs - fromMs) / 86_400_000) + 1
    if (days <= 92) {
      const cursor = new Date(fromMs)
      cursor.setUTCHours(0, 0, 0, 0)
      const end = new Date(toMs)
      end.setUTCHours(0, 0, 0, 0)
      while (cursor.getTime() <= end.getTime()) {
        const date = cursor.toISOString().slice(0, 10)
        if (!buckets.has(date)) buckets.set(date, { date, ...emptyMetrics() })
        cursor.setUTCDate(cursor.getUTCDate() + 1)
      }
    }
  }

  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date))
}

function toolName(item: CanonicalObservation): string {
  const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
    ? item.payload as Record<string, unknown>
    : {}
  for (const key of ['nativeToolName', 'toolName', 'tool_name', 'name']) {
    const value = payload[key]
    if (typeof value === 'string' && value) return value
  }
  return 'unknown'
}

function toolCategory(nativeName: string): string {
  const lower = nativeName.toLowerCase()
  const mcp = lower.match(/^mcp__(.+?)__(.+)$/)
  if (mcp?.[1]) return `MCP：${mcp[1]}`
  if (lower === 'skill') return '技能调用'
  if (/(^|[_-])(read|cat|view|open)([_-]|$)/.test(lower)) return '读取文件'
  if (/(^|[_-])(write|edit|patch|apply)([_-]|$)/.test(lower)) return '修改文件'
  if (/(^|[_-])(grep|search|find|glob|list)([_-]|$)/.test(lower)) return '搜索定位'
  if (/(^|[_-])(bash|shell|exec|terminal|command|run)([_-]|$)/.test(lower)) return '命令执行'
  if (/(^|[_-])(web|http|fetch|browser)([_-]|$)/.test(lower)) return '网络访问'
  return nativeName
}

async function fallbackSessions(storage: StorageService): Promise<SessionLoadResult> {
  const observations = await storage.repositories.observations.query({
    order: 'desc',
    limit: FALLBACK_OBSERVATION_LIMIT,
  })
  const grouped = new Map<string, CanonicalObservation[]>()
  for (const observation of observations) {
    const list = grouped.get(observation.logicalSessionId) ?? []
    list.push(observation)
    grouped.set(observation.logicalSessionId, list)
  }

  const items: SessionSummaryRecord[] = []
  for (const [logicalSessionId, group] of grouped) {
    const logical = await storage.repositories.sessions.getLogicalSession(logicalSessionId)
    if (!logical) continue
    const installation = await storage.repositories.installations.get(logical.installationId)
    if (!installation) continue
    const sourceIds = new Set<string>()
    for (const sourceSessionId of new Set(group.map(item => item.sourceSessionId))) {
      const sourceSession = await storage.repositories.sessions.getSourceSession(sourceSessionId)
      if (sourceSession) sourceIds.add(sourceSession.sourceId)
    }
    const times = group.map(effectiveAt).sort()
    const toolCount = group.filter(item => item.kind === 'tool.call').length
    const errorCount = group.filter(item => {
      if (item.kind !== 'tool.result' || !item.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) return false
      return (item.payload as Record<string, unknown>).success === false
    }).length
    const userCount = group.filter(item => item.kind === 'message.user').length
    const firstContent = [...group]
      .sort((a, b) => effectiveAt(a).localeCompare(effectiveAt(b)))
      .find(item => item.kind !== 'session.lifecycle')
    items.push({
      logicalSessionId,
      installationId: logical.installationId,
      productId: installation.productId,
      sourceIds: [...sourceIds].sort(),
      ...(logical.projectId ? { projectId: logical.projectId } : {}),
      ...(logical.workspaceId ? { workspaceId: logical.workspaceId } : {}),
      ...(logical.title ? { title: logical.title } : {}),
      startedAt: times[0] ?? logical.startedAt ?? new Date(0).toISOString(),
      endedAt: times.at(-1) ?? logical.endedAt ?? times[0] ?? new Date(0).toISOString(),
      observationCount: group.length,
      interactionCount: userCount + (firstContent && firstContent.kind !== 'message.user' ? 1 : 0),
      toolCount,
      errorCount,
    })
    if (items.length >= SESSION_SAMPLE_LIMIT) break
  }
  items.sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.logicalSessionId.localeCompare(b.logicalSessionId))
  return {
    items: items.slice(0, SESSION_SAMPLE_LIMIT),
    sampled: observations.length >= FALLBACK_OBSERVATION_LIMIT || grouped.size > SESSION_SAMPLE_LIMIT,
  }
}

async function loadSessions(storage: StorageService): Promise<SessionLoadResult> {
  if (!storage.sessionSummaries) return fallbackSessions(storage)
  const response = await storage.sessionSummaries.query({ limit: SESSION_SAMPLE_LIMIT })
  return { items: response.items, sampled: response.hasMore }
}

async function loadToolCalls(
  storage: StorageService,
  sessions: SessionSummaryRecord[],
  query: InsightsQueryDto,
): Promise<CanonicalObservation[]> {
  if (!sessions.length) return []
  const ids = sessions.map(item => item.logicalSessionId)
  const calls: CanonicalObservation[] = []
  for (let offset = 0; offset < ids.length; offset += 100) {
    const logicalSessionIds = ids.slice(offset, offset + 100)
    let after: ObservationCursor | undefined
    while (true) {
      const page = await storage.repositories.observations.query({
        logicalSessionIds,
        kind: 'tool.call',
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        ...(after ? { after } : {}),
        order: 'asc',
        limit: OBSERVATION_SCAN_CHUNK,
      })
      if (!page.length) break
      calls.push(...page)
      if (page.length < OBSERVATION_SCAN_CHUNK) break
      after = observationCursor(page[page.length - 1]!)
    }
  }

  if (!query.sourceId) return calls
  const sourceCache = new Map<string, SourceSession | null>()
  const filtered: CanonicalObservation[] = []
  for (const call of calls) {
    let source = sourceCache.get(call.sourceSessionId)
    if (source === undefined) {
      source = await storage.repositories.sessions.getSourceSession(call.sourceSessionId)
      sourceCache.set(call.sourceSessionId, source)
    }
    if (source?.sourceId === query.sourceId) filtered.push(call)
  }
  return filtered
}

function workflowPatterns(calls: CanonicalObservation[]): InsightWorkflowPatternDto[] {
  const bySession = new Map<string, CanonicalObservation[]>()
  for (const call of calls) {
    const list = bySession.get(call.logicalSessionId) ?? []
    list.push(call)
    bySession.set(call.logicalSessionId, list)
  }

  interface PatternAccumulator {
    key: string
    steps: string[]
    sessionIds: Set<string>
    occurrenceCount: number
    observationIds: string[]
  }
  const patterns = new Map<string, PatternAccumulator>()

  for (const [sessionId, sessionCalls] of bySession) {
    sessionCalls.sort((a, b) => effectiveAt(a).localeCompare(effectiveAt(b))
      || (a.canonicalSequence ?? a.sourceSequence ?? Number.MAX_SAFE_INTEGER)
        - (b.canonicalSequence ?? b.sourceSequence ?? Number.MAX_SAFE_INTEGER)
      || a.id.localeCompare(b.id))
    const normalized: Array<{ category: string; observationId: string }> = []
    for (const call of sessionCalls) {
      const category = toolCategory(toolName(call))
      if (normalized.at(-1)?.category === category) continue
      normalized.push({ category, observationId: call.id })
    }

    for (const length of [2, 3]) {
      for (let index = 0; index + length <= normalized.length; index += 1) {
        const window = normalized.slice(index, index + length)
        const steps = window.map(item => item.category)
        const key = steps.join(' → ')
        let pattern = patterns.get(key)
        if (!pattern) {
          pattern = { key, steps, sessionIds: new Set(), occurrenceCount: 0, observationIds: [] }
          patterns.set(key, pattern)
        }
        pattern.sessionIds.add(sessionId)
        pattern.occurrenceCount += 1
        for (const item of window) {
          if (pattern.observationIds.length >= MAX_PATTERN_OBSERVATIONS) break
          if (!pattern.observationIds.includes(item.observationId)) pattern.observationIds.push(item.observationId)
        }
      }
    }
  }

  return [...patterns.values()]
    .filter(item => item.sessionIds.size >= WORKFLOW_PATTERN_MINIMUM_SESSIONS)
    .sort((a, b) => b.sessionIds.size - a.sessionIds.size
      || b.occurrenceCount - a.occurrenceCount
      || a.key.localeCompare(b.key))
    .slice(0, MAX_WORKFLOW_PATTERNS)
    .map(item => ({
      key: item.key,
      steps: item.steps,
      sessionCount: item.sessionIds.size,
      occurrenceCount: item.occurrenceCount,
      sampleSessionIds: [...item.sessionIds].sort().slice(0, 5),
      observationIds: item.observationIds,
      derivation: 'deterministic-sequence' as const,
    }))
}

export class UsageInsightsProjection {
  private readonly usage: ToolAssetUsageProjection

  constructor(private readonly storage: StorageService) {
    this.usage = new ToolAssetUsageProjection(storage)
  }

  async query(query: InsightsQueryDto = {}): Promise<InsightsResponseDto> {
    if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) {
      throw new Error('Insights from must be earlier than or equal to to')
    }

    const loaded = await loadSessions(this.storage)
    const sessions = loaded.items.filter(item => matchesScope(item, query))
    const summary = metricsFor(sessions)
    const usage = await this.usage.query({
      ...(query.sourceId ? { sourceId: query.sourceId } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      limit: 500,
    })

    const agentMap = new Map<string, {
      metrics: InsightMetricSetDto
      productIds: Set<string>
      observedAssetCallCount: number
    }>()
    for (const session of sessions) {
      for (const sourceId of session.sourceIds) {
        if (query.sourceId && sourceId !== query.sourceId) continue
        let agent = agentMap.get(sourceId)
        if (!agent) {
          agent = { metrics: emptyMetrics(), productIds: new Set(), observedAssetCallCount: 0 }
          agentMap.set(sourceId, agent)
        }
        agent.productIds.add(session.productId)
        addSession(agent.metrics, session)
      }
    }
    for (const asset of usage.assets) {
      for (const sourceId of asset.sourceIds) {
        const agent = agentMap.get(sourceId)
        if (agent) agent.observedAssetCallCount += asset.callCount
      }
    }
    const agents: InsightAgentUsageDto[] = [...agentMap.entries()].map(([sourceId, value]) => ({
      sourceId,
      productIds: [...value.productIds].sort(),
      observedAssetCallCount: value.observedAssetCallCount,
      ...value.metrics,
    }))
    agents.sort((a, b) => b.sessionCount - a.sessionCount || a.sourceId.localeCompare(b.sourceId))

    const calls = await loadToolCalls(this.storage, sessions, query)

    let comparison: InsightsResponseDto['comparison']
    if (query.from) {
      const currentFromMs = Date.parse(query.from)
      const currentTo = query.to ?? new Date().toISOString()
      const currentToMs = Date.parse(currentTo)
      const width = currentToMs - currentFromMs
      if (Number.isFinite(width) && width > 0) {
        const previousToMs = currentFromMs - 1
        const previousFromMs = previousToMs - width
        const previousFrom = new Date(previousFromMs).toISOString()
        const previousTo = new Date(previousToMs).toISOString()
        const previousSessions = loaded.items.filter(item => matchesScope(item, {
          ...(query.sourceId ? { sourceId: query.sourceId } : {}),
          ...(query.projectId ? { projectId: query.projectId } : {}),
          from: previousFrom,
          to: previousTo,
        }))
        const previous = metricsFor(previousSessions)
        comparison = {
          current: summary,
          previous,
          delta: metricDelta(summary, previous),
          currentFrom: query.from,
          currentTo,
          previousFrom,
          previousTo,
        }
      }
    }

    return {
      summary,
      trend: trendFor(sessions, query),
      agents,
      assets: usage.assets.map(asset => ({
        type: asset.type,
        canonicalName: asset.canonicalName,
        sourceIds: asset.sourceIds,
        callCount: asset.callCount,
        firstUsedAt: asset.firstUsedAt,
        lastUsedAt: asset.lastUsedAt,
        attribution: asset.attribution,
        confidence: asset.confidence,
        observationIds: asset.observationIds,
      })),
      workflowPatterns: workflowPatterns(calls),
      ...(comparison ? { comparison } : {}),
      meta: {
        protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
        generatedAt: new Date().toISOString(),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
        sampled: loaded.sampled,
        sessionSampleLimit: SESSION_SAMPLE_LIMIT,
        workflowPatternMinimumSessions: WORKFLOW_PATTERN_MINIMUM_SESSIONS,
        notes: [
          '趋势、Agent 对比与周期比较均由已采集会话事实直接聚合。',
          '资产采用只表示可可靠归因到 Skill 或 MCP 的已观察调用。',
          '工作流模式是工具类别连续序列的确定性统计，只表示共同出现，不表示因果关系。',
        ],
      },
    }
  }
}

export const insightsProjectionInternals = {
  toolCategory,
  workflowPatterns,
  percentDelta,
}
