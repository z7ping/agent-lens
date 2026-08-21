import type { CanonicalObservation, StorageService } from '@agent-lens/core'
import { SessionProjection } from '@agent-lens/projection-session'
import { TimelineProjection } from '@agent-lens/projection-timeline'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type JsonValue,
  type ReviewEventCategory,
  type ReviewEventNodeDto,
  type ReviewInteractionDto,
  type ReviewMessageNodeDto,
  type ReviewNodeDto,
  type ReviewQueryDto,
  type ReviewResponseDto,
  type ReviewSessionDetailDto,
  type ReviewSessionSummaryDto,
  type ReviewToolNodeDto,
  type TimelineItemDto,
} from '@agent-lens/protocol'

const MAX_SESSIONS = 500
const DEFAULT_LIMIT = 100

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
    'artifact.action': '产物操作',
    usage: '用量',
    unknown: '原始事件',
  }
  return labels[kind] ?? kind
}

function buildNodes(items: TimelineItemDto[]): ReviewNodeDto[] {
  const nodes: ReviewNodeDto[] = []
  const toolsByCallId = new Map<string, ReviewToolNodeDto>()

  for (const item of items) {
    if (item.kind === 'message.user' || item.kind === 'message.assistant' || item.kind === 'message.reasoning') {
      const node: ReviewMessageNodeDto = {
        type: 'message', id: item.id,
        role: item.kind === 'message.user' ? 'user' : item.kind === 'message.assistant' ? 'assistant' : 'reasoning',
        at: item.effectiveAt, sourceId: item.sourceId,
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
        type: 'tool', id: item.id, at: item.effectiveAt, sourceId: item.sourceId,
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
      type: 'event', id: item.id, at: item.effectiveAt, sourceId: item.sourceId,
      kind: item.kind, category: eventCategory(item.kind), label: eventLabel(item.kind),
      payload: item.payload, evidence: item.evidence, observationIds: [item.id],
    }
    nodes.push(node)
  }
  return nodes
}

function buildInteractions(items: TimelineItemDto[]): ReviewInteractionDto[] {
  const groups: TimelineItemDto[][] = []
  let current: TimelineItemDto[] = []
  for (const item of items) {
    if (item.kind === 'message.user' && current.length) {
      groups.push(current)
      current = []
    }
    if (!current.length && item.kind === 'session.lifecycle') continue
    current.push(item)
  }
  if (current.length) groups.push(current)

  return groups.map((group, index) => ({
    id: `${group[0]!.logicalSessionId}:review:${index + 1}`,
    ordinal: index + 1,
    trigger: group[0]!.kind === 'message.user' ? 'user' : 'background',
    startedAt: group[0]!.effectiveAt,
    endedAt: group[group.length - 1]!.effectiveAt,
    nodes: buildNodes(group),
  }))
}

function durationMs(startedAt: string, endedAt: string): number {
  const value = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function observationError(item: CanonicalObservation): boolean {
  if (item.kind !== 'tool.result') return false
  return asRecord(item.payload).success === false
}

export class ReviewProjection {
  private readonly sessions: SessionProjection
  private readonly timeline: TimelineProjection

  constructor(private readonly storage: StorageService) {
    this.sessions = new SessionProjection(storage)
    this.timeline = new TimelineProjection(storage)
  }

  private async summary(session: Awaited<ReturnType<SessionProjection['query']>>['items'][number]): Promise<ReviewSessionSummaryDto> {
    const logical = await this.storage.repositories.sessions.getLogicalSession(session.id)
    const project = session.projectId ? await this.storage.repositories.sessions.getProject(session.projectId) : null
    const workspace = session.workspaceId ? await this.storage.repositories.sessions.getWorkspace(session.workspaceId) : null
    const observations = await this.storage.repositories.observations.query({ logicalSessionId: session.id, limit: 5000 })
    const firstUser = observations.find(item => item.kind === 'message.user')
    const toolCount = observations.filter(item => item.kind === 'tool.call').length
    const errorCount = observations.filter(observationError).length
    return {
      id: session.id, installationId: session.installationId, productId: session.productId,
      sourceIds: session.sourceIds,
      ...(session.projectId ? { projectId: session.projectId } : {}),
      ...(project?.name ? { projectName: project.name } : {}),
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
      ...(workspace?.path ? { workspacePath: workspace.path } : {}),
      ...(logical?.title ? { title: logical.title } : {}),
      ...(firstUser ? { preview: textFromPayload(firstUser.payload) } : {}),
      startedAt: session.startedAt, endedAt: session.endedAt,
      durationMs: durationMs(session.startedAt, session.endedAt),
      observationCount: session.observationCount, interactionCount: session.interactionCount,
      toolCount, errorCount, hasErrors: errorCount > 0,
    }
  }

  async query(query: ReviewQueryDto = {}): Promise<ReviewResponseDto> {
    const requestedLimit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, MAX_SESSIONS))
    const raw = await this.sessions.query({ limit: MAX_SESSIONS })
    const summaries = await Promise.all(raw.items.map(item => this.summary(item)))
    const search = query.search?.trim().toLowerCase()
    const filtered = summaries.filter(item => {
      if (query.sourceId && !item.sourceIds.includes(query.sourceId)) return false
      if (query.projectId && item.projectId !== query.projectId) return false
      if (query.from && item.endedAt < query.from) return false
      if (query.to && item.startedAt > query.to) return false
      if (query.status === 'with-errors' && !item.hasErrors) return false
      if (query.status === 'clean' && item.hasErrors) return false
      if (search) {
        const haystack = [item.title, item.preview, item.projectName, item.workspacePath, ...item.sourceIds].filter(Boolean).join('\n').toLowerCase()
        if (!haystack.includes(search)) return false
      }
      return true
    })
    filtered.sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.id.localeCompare(b.id))
    const hasMore = filtered.length > requestedLimit
    return {
      items: filtered.slice(0, requestedLimit),
      meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION, count: Math.min(filtered.length, requestedLimit), hasMore, generatedAt: new Date().toISOString() },
    }
  }

  async get(logicalSessionId: string): Promise<ReviewSessionDetailDto | null> {
    const sessionResult = await this.sessions.query({ logicalSessionId, limit: 1 })
    const session = sessionResult.items.find(item => item.id === logicalSessionId)
    if (!session) return null
    const summary = await this.summary(session)
    const timeline = await this.timeline.query({ logicalSessionId, limit: 1000 })
    return { ...summary, interactions: buildInteractions(timeline.items) }
  }
}

export const reviewProjectionInternals = { textFromPayload, buildNodes, buildInteractions, eventCategory }
