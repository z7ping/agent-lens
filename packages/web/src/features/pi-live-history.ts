import type { PiLiveSnapshotDto } from '@agent-lens/protocol'

export type PiLiveHistoryItem =
  | {
      id: string
      kind: 'message'
      role: 'user' | 'assistant'
      text: string
      at: string
    }
  | {
      id: string
      kind: 'thinking'
      text: string
      at: string
    }
  | {
      id: string
      kind: 'tool'
      callId: string
      name: string
      summary: string
      output: string
      status: 'success' | 'error' | 'unknown'
      at: string
    }
  | {
      id: string
      kind: 'lifecycle'
      event: 'model.changed' | 'thinking.level.changed' | 'context.compaction' | 'context.summary' | 'session.info'
      label: string
      detail: string
      at: string
    }

interface ToolResultFact {
  entryId: string
  callId: string
  name: string
  output: string
  status: 'success' | 'error'
  at: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function timestamp(entry: Record<string, unknown>, message?: Record<string, unknown>): string {
  const value = entry.timestamp ?? message?.timestamp
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(raw => {
    if (typeof raw === 'string') return raw
    const block = record(raw)
    if (block.type === 'text') return stringValue(block.text)
    return ''
  }).filter(Boolean).join('\n\n')
}

function thinkingText(block: Record<string, unknown>): string {
  return stringValue(block.thinking || block.text)
}

function compact(value: unknown, max = 160): string {
  let text = ''
  if (typeof value === 'string') text = value
  else {
    try { text = JSON.stringify(value) } catch { text = String(value ?? '') }
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function toolResultFacts(entries: PiLiveSnapshotDto['entries']): Map<string, ToolResultFact> {
  const result = new Map<string, ToolResultFact>()
  for (const raw of entries) {
    const entry = record(raw)
    if (entry.type !== 'message') continue
    const message = record(entry.message)
    if (message.role !== 'tool' && message.role !== 'toolResult') continue
    const callId = stringValue(message.toolCallId)
    if (!callId) continue
    result.set(callId, {
      entryId: stringValue(entry.id) || `tool-result-${callId}`,
      callId,
      name: stringValue(message.toolName) || 'tool',
      output: contentText(message.content),
      status: message.isError === true ? 'error' : 'success',
      at: timestamp(entry, message),
    })
  }
  return result
}

function messageItems(
  entry: Record<string, unknown>,
  index: number,
  results: Map<string, ToolResultFact>,
  consumedResults: Set<string>,
): PiLiveHistoryItem[] {
  const message = record(entry.message)
  const role = stringValue(message.role)
  const entryId = stringValue(entry.id) || `message-${index}`
  const at = timestamp(entry, message)
  if (role === 'user') {
    const text = contentText(message.content ?? message.text)
    return text.trim() ? [{ id: entryId, kind: 'message', role: 'user', text, at }] : []
  }
  if (role === 'assistant') {
    const content = Array.isArray(message.content) ? message.content : []
    const items: PiLiveHistoryItem[] = []
    let blockIndex = 0
    for (const raw of content) {
      const block = record(raw)
      const blockType = stringValue(block.type)
      const id = `${entryId}:${blockIndex++}`
      if (blockType === 'text') {
        const text = stringValue(block.text)
        if (text.trim()) items.push({ id, kind: 'message', role: 'assistant', text, at })
        continue
      }
      if (blockType === 'thinking') {
        const text = thinkingText(block)
        if (text.trim()) items.push({ id, kind: 'thinking', text, at })
        continue
      }
      if (blockType === 'toolCall') {
        const callId = stringValue(block.id) || `${entryId}:tool:${blockIndex}`
        const paired = results.get(callId)
        if (paired) consumedResults.add(callId)
        items.push({
          id,
          kind: 'tool',
          callId,
          name: stringValue(block.name) || paired?.name || 'tool',
          summary: compact(block.arguments ?? block.args ?? {}),
          output: paired?.output ?? '',
          status: paired?.status ?? 'unknown',
          at,
        })
      }
    }
    if (!content.length) {
      const text = stringValue(message.text)
      if (text.trim()) items.push({ id: entryId, kind: 'message', role: 'assistant', text, at })
    }
    return items
  }
  return []
}

function lifecycleItem(entry: Record<string, unknown>, index: number): PiLiveHistoryItem | null {
  const type = stringValue(entry.type)
  const id = stringValue(entry.id) || `${type || 'entry'}-${index}`
  const at = timestamp(entry)
  if (type === 'model_change') {
    const provider = stringValue(entry.provider)
    const model = stringValue(entry.modelId || entry.model)
    return { id, kind: 'lifecycle', event: 'model.changed', label: '模型已切换', detail: [provider, model].filter(Boolean).join(' / ') || '未知模型', at }
  }
  if (type === 'thinking_level_change') {
    const level = stringValue(entry.thinkingLevel || entry.level)
    return { id, kind: 'lifecycle', event: 'thinking.level.changed', label: '推理级别已切换', detail: level || '未知级别', at }
  }
  if (type === 'compaction') {
    const before = typeof entry.tokensBefore === 'number' ? `${entry.tokensBefore} tokens` : ''
    const summary = stringValue(entry.summary)
    return { id, kind: 'lifecycle', event: 'context.compaction', label: '上下文已压缩', detail: [before, summary].filter(Boolean).join(' · '), at }
  }
  if (type === 'branch_summary') {
    return { id, kind: 'lifecycle', event: 'context.summary', label: '分支摘要', detail: stringValue(entry.summary), at }
  }
  if (type === 'session_info') {
    return { id, kind: 'lifecycle', event: 'session.info', label: '会话信息已更新', detail: stringValue(entry.name), at }
  }
  return null
}

export function projectPiLiveHistory(snapshot: PiLiveSnapshotDto | null): PiLiveHistoryItem[] {
  if (!snapshot) return []
  const results = toolResultFacts(snapshot.entries)
  const consumedResults = new Set<string>()
  const items: PiLiveHistoryItem[] = []

  snapshot.entries.forEach((raw, index) => {
    const entry = record(raw)
    if (entry.type === 'message') {
      const message = record(entry.message)
      if (message.role === 'tool' || message.role === 'toolResult') return
      items.push(...messageItems(entry, index, results, consumedResults))
      return
    }
    const lifecycle = lifecycleItem(entry, index)
    if (lifecycle) items.push(lifecycle)
  })

  for (const fact of results.values()) {
    if (consumedResults.has(fact.callId)) continue
    items.push({
      id: fact.entryId,
      kind: 'tool',
      callId: fact.callId,
      name: fact.name,
      summary: '未找到对应 Tool Call，保留原生 Tool Result 事实',
      output: fact.output,
      status: fact.status,
      at: fact.at,
    })
  }

  return items
}
