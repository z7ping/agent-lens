import type { LiveEvent } from '@agent-lens/core'

export const codexRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
export const codexText = (value: unknown): string => typeof value === 'string' ? value : ''
function preview(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text.length > 4000 ? text.slice(0, 4000) + '…' : text
}
function isTool(item: Record<string, unknown>): boolean {
  return ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch',
    'collabAgentToolCall', 'dynamicToolCall', 'imageView'].includes(codexText(item.type))
}
function toolName(item: Record<string, unknown>): string {
  if (item.type === 'commandExecution') return 'shell'
  if (item.type === 'fileChange') return 'fileChange'
  return codexText(item.tool) || codexText(item.type) || 'tool'
}

/** Translate official Codex notification semantics, not guessed CLI JSONL fields. */
export function normalizeCodexEvent(method: string, params: Record<string, unknown>): LiveEvent | undefined {
  const item = codexRecord(params.item)
  const id = codexText(params.itemId) || codexText(item.id)
  const common = id ? { messageId: id } : {}
  if (method === 'turn/started') return { type: 'status', status: 'running' }
  if (method === 'turn/completed') {
    const turn = codexRecord(params.turn)
    const status = codexText(turn.status)
    return {
      type: 'completed',
      status: status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed',
      ...(codexText(codexRecord(turn.error).message)
        ? { message: codexText(codexRecord(turn.error).message) } : {}),
    }
  }
  if (method === 'item/agentMessage/delta') {
    const delta = codexText(params.delta)
    return delta ? { type: 'text.delta', delta, ...common } : undefined
  }
  if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
    const delta = codexText(params.delta)
    return delta ? { type: 'reasoning.delta', delta, ...common } : undefined
  }
  if (method === 'item/commandExecution/outputDelta') {
    return { type: 'tool.output', callId: id, name: 'shell', output: codexText(params.delta) }
  }
  if (method === 'item/started' && isTool(item)) {
    return {
      type: 'tool.start', callId: id, name: toolName(item),
      ...(item.type === 'mcpToolCall' ? { toolSourceType: 'mcp' as const } : {}),
      ...(item.command || item.changes || item.arguments
        ? { inputPreview: preview(item.command || item.changes || item.arguments) } : {}),
    }
  }
  if (method === 'item/completed') {
    if (isTool(item)) {
      return {
        type: 'tool.end', callId: id, name: toolName(item),
        status: ['failed', 'error', 'declined'].includes(codexText(item.status)) ? 'error' : 'success',
        ...(item.aggregatedOutput || item.result
          ? { output: preview(item.aggregatedOutput || item.result) } : {}),
      }
    }
    if (item.type === 'agentMessage') return { type: 'text.end', text: codexText(item.text), ...common }
  }
  if (method === 'error') {
    return { type: 'error', message: codexText(params.message) || codexText(codexRecord(params.error).message) || 'Codex error' }
  }
  if (method === 'thread/name/updated' && codexText(params.name)) {
    return { type: 'title.update', title: codexText(params.name) }
  }
  return undefined
}

/** Native items become shared transcript entries; no Codex-specific renderer. */
export function codexSnapshotEntries(turns: unknown[], limit: number): { entries: unknown[], hasEarlier: boolean } {
  const entries: Record<string, unknown>[] = []
  for (const rawTurn of turns) {
    const turn = codexRecord(rawTurn)
    for (const rawItem of Array.isArray(turn.items) ? turn.items : []) {
      const item = codexRecord(rawItem)
      const id = codexText(item.id)
      if (item.type === 'userMessage') {
        const content = Array.isArray(item.content)
          ? item.content.map(v => codexText(codexRecord(v).text)).filter(Boolean).join('\n') : ''
        if (content) entries.push({ type: 'message', id, role: 'user', text: content })
      } else if (item.type === 'agentMessage' && codexText(item.text)) {
        entries.push({ type: 'message', id, role: 'assistant', text: codexText(item.text) })
      } else if (item.type === 'reasoning') {
        const summary = Array.isArray(item.summary)
          ? item.summary.map(v => codexText(v)).filter(Boolean).join('\n') : codexText(item.summary)
        if (summary) entries.push({
          id, role: 'assistant', content: [{ type: 'reasoning', text: summary }],
        })
      } else if (isTool(item)) {
        entries.push({ id, role: 'assistant', content: [{
          type: 'toolCall', id, name: toolName(item),
          arguments: item.command || item.changes || item.arguments || '',
        }] })
        if (item.aggregatedOutput || item.result) entries.push({
          role: 'toolResult', toolCallId: id, toolName: toolName(item),
          content: preview(item.aggregatedOutput || item.result),
          isError: ['failed', 'error'].includes(codexText(item.status)),
        })
      }
    }
  }
  const max = Math.max(1, Math.min(500, Math.floor(limit)))
  return { entries: entries.slice(-max), hasEarlier: entries.length > max }
}
