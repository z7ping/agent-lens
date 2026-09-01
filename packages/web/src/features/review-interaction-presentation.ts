import type { ReviewEventNodeDto, ReviewMessageNodeDto, ReviewNodeDto, ReviewToolNodeDto } from '@agent-lens/protocol'

export type ReviewInteractionPresentationEntry =
  | { type: 'message'; node: ReviewMessageNodeDto }
  | { type: 'reasoning'; node: ReviewMessageNodeDto; tools: ReviewToolNodeDto[] }
  | { type: 'tool-group'; items: ReviewToolNodeDto[] }
  | { type: 'event'; node: ReviewEventNodeDto }
  | { type: 'raw-event-group'; items: ReviewEventNodeDto[] }

function reasoningIds(node: ReviewMessageNodeDto): Set<string> {
  return new Set([
    node.id,
    node.nativeEventId,
    ...node.observationIds,
  ].filter((value): value is string => Boolean(value)))
}

function sourceRecordIds(node: ReviewMessageNodeDto | ReviewEventNodeDto): Set<string> {
  return new Set(node.evidence.map(item => item.sourceRecordId).filter((value): value is string => Boolean(value)))
}

function explicitParentIds(node: ReviewToolNodeDto): string[] {
  return [node.nativeParentEventId, node.parentObservationId].filter((value): value is string => Boolean(value))
}

/**
 * 只使用协议中已经明确存在的父关系，不根据时间、相邻位置或 Tool 类型猜层级。
 *
 * - Tool 的 nativeParentEventId / parentObservationId 明确指向 reasoning 时，才归到该 Thinking 下；
 * - 没有明确父关系，或者出现歧义时，Tool 继续保持 Agent Turn 一级；
 * - 同一 sourceId 内匹配，避免不同来源的原生 ID 碰撞；
 * - parser replay 将旧 unknown 提升为 reasoning 后，若两者证据指向同一 SourceRecord，表现层只展示 reasoning。
 */
export function projectReviewInteractionPresentation(nodes: ReviewNodeDto[]): ReviewInteractionPresentationEntry[] {
  const reasoning = nodes.filter((node): node is ReviewMessageNodeDto => node.type === 'message' && node.role === 'reasoning')
  const identities = reasoning.map(node => ({ node, ids: reasoningIds(node) }))
  const reasoningSourceRecords = new Set(reasoning.flatMap(node => [...sourceRecordIds(node)]))
  const children = new Map<string, ReviewToolNodeDto[]>()
  const nestedToolIds = new Set<string>()

  for (const node of nodes) {
    if (node.type !== 'tool') continue
    const parents = explicitParentIds(node)
    if (!parents.length) continue
    const matches = identities.filter(item => item.node.sourceId === node.sourceId && parents.some(parent => item.ids.has(parent)))
    if (matches.length !== 1) continue
    const parent = matches[0]!.node
    const tools = children.get(parent.id) ?? []
    tools.push(node)
    children.set(parent.id, tools)
    nestedToolIds.add(node.id)
  }

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
    if (node.type === 'tool') {
      if (nestedToolIds.has(node.id)) continue
      flushRawEvents()
      tools.push(node)
      continue
    }
    if (node.type === 'event' && node.category === 'unknown') {
      const duplicateOfReasoning = [...sourceRecordIds(node)].some(id => reasoningSourceRecords.has(id))
      if (duplicateOfReasoning) continue
      flushTools()
      rawEvents.push(node)
      continue
    }

    flushTools()
    flushRawEvents()
    if (node.type === 'message') {
      if (node.role === 'reasoning') result.push({ type: 'reasoning', node, tools: children.get(node.id) ?? [] })
      else result.push({ type: 'message', node })
    } else {
      result.push({ type: 'event', node })
    }
  }
  flushTools()
  flushRawEvents()
  return result
}
