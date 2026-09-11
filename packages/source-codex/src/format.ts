import { asRecord } from '@agent-lens/source-support'

export interface CodexSessionMetadata {
  nativeSessionId: string
  cwd?: string
  cliVersion?: string
  title?: string
  startedAt?: string
}

export interface CodexStoredEnvelope {
  entry: Record<string, unknown>
  session: CodexSessionMetadata
}

export function messageText(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks
  if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) {
    return Array.isArray(blocks) ? blocks.map(messageText).filter(Boolean).join('\n\n') : ''
  }
  const item = asRecord(blocks)
  for (const key of ['text', 'input_text', 'output_text', 'content', 'refusal']) {
    const value = item[key]
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return messageText(value)
  }
  return ''
}

function completedItem(payload: Record<string, unknown>): Record<string, unknown> {
  return payload.type === 'item_completed' ? asRecord(payload.item) : {}
}

export function nativeIdForEntry(entry: Record<string, unknown>): string | undefined {
  const payload = asRecord(entry.payload)
  const item = completedItem(payload)
  for (const candidate of [item.id, payload.id]) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return undefined
}

export function nativeTypeForEntry(entry: Record<string, unknown>): string {
  const top = typeof entry.type === 'string' ? entry.type : 'unknown'
  const payload = asRecord(entry.payload)
  const inner = typeof payload.type === 'string' ? payload.type : undefined
  if (!inner) return top
  const item = completedItem(payload)
  const itemType = typeof item.type === 'string' ? item.type : undefined
  return itemType ? `${top}/${inner}/${itemType}` : `${top}/${inner}`
}

export function parseFunctionOutput(output: unknown): {
  success: boolean
  exitCode?: number
  output?: string
} {
  const text = String(output ?? '')
  const exitMatch = text.match(/Exit code:\s*(-?\d+)/i)
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1]!, 10) : undefined
  const outputIndex = text.indexOf('Output:')
  const body = outputIndex >= 0 ? text.slice(outputIndex + 'Output:'.length).trim() : text.trim()
  return {
    success: exitCode === undefined || exitCode === 0,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(body ? { output: body } : {}),
  }
}
