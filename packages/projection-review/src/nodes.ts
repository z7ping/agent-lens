import {
  type JsonValue,
  type ReviewEventCategory,
  type ReviewEventNodeDto,
  type ReviewInteractionDto,
  type ReviewMessageNodeDto,
  type ReviewNodeDto,
  type ReviewNodeSourceDto,
  type ReviewToolNodeDto,
  type TimelineItemDto,
} from '@agent-lens/protocol'

export function asRecord(value: JsonValue): Record<string, JsonValue>
export function asRecord(value: unknown): Record<string, unknown>
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function stringField(record: Readonly<Record<string, unknown>>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

export function textFromPayload(value: JsonValue | unknown): string | undefined {
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

export function eventCategory(kind: TimelineItemDto['kind']): ReviewEventCategory {
  if (kind.startsWith('permission.')) return 'permission'
  if (kind.startsWith('subagent.')) return 'subagent'
  if (kind === 'runtime.startup') return 'lifecycle'
  if (kind.startsWith('context.')) return 'context'
  if (kind.startsWith('model.') || kind.startsWith('reasoning.')) return 'model'
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

export function buildNodes(items: TimelineItemDto[]): ReviewNodeDto[] {
  const nodes: ReviewNodeDto[] = []
  const toolsByCallId = new Map<string, ReviewToolNodeDto>()

  for (const item of items) {
    if (item.kind === 'message.user' || item.kind === 'message.assistant' || item.kind === 'message.commentary' || item.kind === 'message.reasoning') {
      const node: ReviewMessageNodeDto = {
        type: 'message',
        id: item.id,
        role: item.kind === 'message.user'
          ? 'user'
          : item.kind === 'message.commentary'
            ? 'commentary'
            : item.kind === 'message.reasoning'
              ? 'reasoning'
              : 'assistant',
        at: item.effectiveAt,
        sourceId: item.sourceId,
        ...reviewNodeSource(item),
        text: textFromPayload(item.payload) ?? '（无可显示文本）',
        payload: item.payload,
        evidence: item.evidence,
        observationIds: [item.id],
      }
      nodes.push(node)
      continue
    }

    if (item.kind === 'tool.call') {
      const payload = asRecord(item.payload)
      const id = toolCallId(item)
      const node: ReviewToolNodeDto = {
        type: 'tool',
        id: item.id,
        at: item.effectiveAt,
        sourceId: item.sourceId,
        ...reviewNodeSource(item),
        name: toolName(item),
        ...(id ? { callId: id } : {}),
        status: 'running',
        startedAt: item.effectiveAt,
        ...(payload.input !== undefined ? { input: payload.input } : {}),
        payload: item.payload,
        evidence: item.evidence,
        observationIds: [item.id],
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
        if (payload.output !== undefined) linked.output = payload.output
        else if (payload.result !== undefined) linked.output = payload.result
        else linked.output = item.payload
        linked.evidence = [...linked.evidence, ...item.evidence]
        linked.observationIds.push(item.id)
        continue
      }
    }

    const node: ReviewEventNodeDto = {
      type: 'event',
      id: item.id,
      at: item.effectiveAt,
      sourceId: item.sourceId,
      ...reviewNodeSource(item),
      kind: item.kind,
      category: eventCategory(item.kind),
      label: eventLabel(item.kind),
      payload: item.payload,
      evidence: item.evidence,
      observationIds: [item.id],
    }
    nodes.push(node)
  }
  return nodes
}

export function splitInteractionGroups(items: TimelineItemDto[]): TimelineItemDto[][] {
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
      const group = [item]
      groups.push(group)
      groupByRoot.set(`background:${item.id}`, group)
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

export function buildInteractionGroups(groups: TimelineItemDto[][], startingOrdinal = 1): ReviewInteractionDto[] {
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

export function buildInteractions(items: TimelineItemDto[], startingOrdinal = 1): ReviewInteractionDto[] {
  return buildInteractionGroups(splitInteractionGroups(items), startingOrdinal)
}
