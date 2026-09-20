import type { ReviewEventNodeDto, ReviewInteractionDto, ReviewMessageNodeDto, ReviewNodeDto, ReviewToolNodeDto } from '@agent-lens/protocol'

export type ReviewProcessPresentationItem =
  | { type: 'message'; node: ReviewMessageNodeDto }
  | { type: 'tool-group'; items: ReviewToolNodeDto[] }
  | { type: 'event'; node: ReviewEventNodeDto }
  | { type: 'raw-event-group'; items: ReviewEventNodeDto[] }


export function projectReviewInteractionToolStats(
  interaction: Pick<ReviewInteractionDto, 'nodes' | 'processSummary'>,
): { toolCount: number; errorCount: number } {
  const tools = interaction.nodes.filter((node): node is ReviewToolNodeDto => node.type === 'tool')
  return {
    toolCount: interaction.processSummary?.toolCount ?? tools.length,
    errorCount: interaction.processSummary?.errorCount ?? tools.filter(tool => tool.status === 'error').length,
  }
}

export type ReviewInteractionPresentationEntry =
  | { type: 'message'; node: ReviewMessageNodeDto }
  | { type: 'reasoning'; node: ReviewMessageNodeDto; tools: ReviewToolNodeDto[] }
  | { type: 'tool-group'; items: ReviewToolNodeDto[] }
  | { type: 'process'; id: string; items: ReviewProcessPresentationItem[] }
  | { type: 'event'; node: ReviewEventNodeDto }
  | { type: 'raw-event-group'; items: ReviewEventNodeDto[] }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringField(value: unknown, ...keys: string[]): string {
  const source = record(value)
  for (const key of keys) {
    const candidate = source[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}

function modelLabelFromPayload(payload: unknown): string | undefined {
  const source = record(payload)
  const nestedModel = record(source.model)
  const provider = stringField(source, 'provider', 'modelProvider', 'model_provider')
    || stringField(nestedModel, 'provider')
  const model = (typeof source.model === 'string' ? source.model.trim() : '')
    || stringField(source, 'modelName', 'model_name', 'modelId', 'model_id')
    || stringField(nestedModel, 'id', 'modelId', 'name')
  return [provider, model].filter(Boolean).join(' / ') || undefined
}

function nodeIdentityIds(node: ReviewMessageNodeDto | ReviewEventNodeDto): Set<string> {
  return new Set([
    node.id,
    node.nativeEventId,
    ...node.observationIds,
  ].filter((value): value is string => Boolean(value)))
}

function nodeParentIds(node: ReviewMessageNodeDto | ReviewEventNodeDto): string[] {
  return [node.nativeParentEventId, node.parentObservationId].filter((value): value is string => Boolean(value))
}

function explicitlyRelated(
  left: ReviewMessageNodeDto | ReviewEventNodeDto,
  right: ReviewMessageNodeDto | ReviewEventNodeDto,
): boolean {
  if (left.sourceId !== right.sourceId) return false
  const leftIds = nodeIdentityIds(left)
  const rightIds = nodeIdentityIds(right)
  return nodeParentIds(left).some(id => rightIds.has(id))
    || nodeParentIds(right).some(id => leftIds.has(id))
}

export function projectReviewMessageModelLabels(nodes: ReviewNodeDto[]): Map<string, string> {
  const labels = new Map<string, string>()
  const activeModels = new Map<string, string>()
  const modelCalls = nodes.filter((node): node is ReviewEventNodeDto => node.type === 'event' && node.kind === 'model.call')

  for (const node of nodes) {
    if (node.type === 'event' && node.kind === 'model.changed') {
      const label = modelLabelFromPayload(node.payload)
      if (label) activeModels.set(node.sourceId, label)
      continue
    }

    if (node.type !== 'message' || node.role !== 'assistant') continue

    const direct = modelLabelFromPayload(node.payload)
    const relatedCalls = modelCalls.filter(call => explicitlyRelated(node, call))
    const correlated = relatedCalls.length === 1 ? modelLabelFromPayload(relatedCalls[0]!.payload) : undefined
    const label = direct ?? correlated ?? activeModels.get(node.sourceId)
    if (label) labels.set(node.id, label)
  }

  return labels
}

function sourceRecordIds(node: ReviewMessageNodeDto | ReviewEventNodeDto): Set<string> {
  return new Set(node.evidence.map(item => item.sourceRecordId).filter((value): value is string => Boolean(value)))
}

function eventAction(node: ReviewEventNodeDto): string {
  const payload = record(node.payload)
  return stringField(payload, 'action', 'event', 'type', 'status').toLowerCase()
}

function isTerminalEvent(node: ReviewEventNodeDto): boolean {
  if (node.kind !== 'session.lifecycle') return false
  return ['turn.completed', 'turn.stopped', 'turn.aborted', 'turn.error'].includes(eventAction(node))
}

function isLegacyPiBenignAssistantStop(node: ReviewEventNodeDto): boolean {
  if (node.sourceId !== 'pi' || node.kind !== 'session.lifecycle' || eventAction(node) !== 'assistant.stop') return false
  const payload = record(node.payload)
  const stopReason = stringField(payload, 'stopReason', 'stop_reason')
  return stopReason === 'stop' || stopReason === 'toolUse'
}

/**
 * 保持 Canonical Review 节点原始顺序，只做两类无损表现变换：
 * 1. 连续 Tool 合成同一个视觉 ToolGroup，但不再把 Tool 移到 reasoning 旁边；
 * 2. parser replay 后，同一 SourceRecord 的旧 unknown / assistant 兼容记录去重。
 *
 * Turn 的统一表现顺序随后收敛为：
 * prompt → process（只含明确的 reasoning / commentary / tool）→ key events / assistant text → terminal → artifacts。
 * 普通 Assistant Text 永远留在主阅读流；没有来源明确语义时，不再根据前后位置猜它是不是 Process。
 */
export function projectReviewInteractionPresentation(nodes: ReviewNodeDto[]): ReviewInteractionPresentationEntry[] {
  const reasoning = nodes.filter((node): node is ReviewMessageNodeDto => node.type === 'message' && node.role === 'reasoning')
  const commentary = nodes.filter((node): node is ReviewMessageNodeDto => node.type === 'message' && node.role === 'commentary')
  const reasoningSourceRecords = new Set(reasoning.flatMap(node => [...sourceRecordIds(node)]))
  const commentarySourceRecords = new Set(commentary.flatMap(node => [...sourceRecordIds(node)]))

  const result: ReviewInteractionPresentationEntry[] = []
  let tools: ReviewToolNodeDto[] = []
  let rawEvents: ReviewEventNodeDto[] = []
  const flushTools = () => {
    if (!tools.length) return
    result.push({ type: 'tool-group', items: tools })
    tools = []
  }
  const flushRawEvents = () => {
    if (!rawEvents.length) return
    result.push({ type: 'raw-event-group', items: rawEvents })
    rawEvents = []
  }

  for (const node of nodes) {
    if (node.type === 'event' && isLegacyPiBenignAssistantStop(node)) continue

    if (node.type === 'tool') {
      flushRawEvents()
      tools.push(node)
      continue
    }

    if (node.type === 'event' && node.category === 'unknown' && node.kind !== 'tool.progress') {
      const duplicateOfReasoning = [...sourceRecordIds(node)].some(id => reasoningSourceRecords.has(id))
      if (duplicateOfReasoning) continue
      flushTools()
      rawEvents.push(node)
      continue
    }

    flushTools()
    flushRawEvents()
    if (node.type === 'message') {
      if (node.role === 'assistant' && [...sourceRecordIds(node)].some(id => commentarySourceRecords.has(id))) continue
      if (node.role === 'reasoning') result.push({ type: 'reasoning', node, tools: [] })
      else result.push({ type: 'message', node })
    } else {
      result.push({ type: 'event', node })
    }
  }
  flushTools()
  flushRawEvents()

  const prompts: ReviewInteractionPresentationEntry[] = []
  const processItems: ReviewProcessPresentationItem[] = []
  const postProcess: ReviewInteractionPresentationEntry[] = []
  const terminal: ReviewInteractionPresentationEntry[] = []
  const artifacts: ReviewInteractionPresentationEntry[] = []

  for (const entry of result) {
    if (entry.type === 'message' && entry.node.role === 'user') {
      prompts.push(entry)
      continue
    }
    if (entry.type === 'message' && entry.node.role === 'assistant') {
      postProcess.push(entry)
      continue
    }
    if (entry.type === 'event' && entry.node.category === 'artifact') {
      artifacts.push(entry)
      continue
    }
    if (entry.type === 'event' && isTerminalEvent(entry.node)) {
      terminal.push(entry)
      continue
    }

    if (entry.type === 'reasoning') processItems.push({ type: 'message', node: entry.node })
    else if (entry.type === 'message' && entry.node.role === 'commentary') processItems.push({ type: 'message', node: entry.node })
    else if (entry.type === 'message') postProcess.push(entry)
    else if (entry.type === 'tool-group') processItems.push(entry)
    else if (entry.type === 'event' && entry.node.kind === 'tool.progress') processItems.push(entry)
    else postProcess.push(entry)
  }

  const grouped: ReviewInteractionPresentationEntry[] = [...prompts]
  if (processItems.length) {
    const first = processItems[0]!
    const id = first.type === 'message'
      ? first.node.id
      : first.type === 'event'
        ? first.node.id
        : first.items[0]?.id ?? 'process'
    grouped.push({ type: 'process', id: `process:${id}`, items: processItems })
  }
  grouped.push(...postProcess, ...terminal, ...artifacts)
  return grouped
}
