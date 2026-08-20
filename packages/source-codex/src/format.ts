const MAX_TEXT = 64 * 1024
const MAX_TOOL_PAYLOAD = 32 * 1024
const MAX_UNKNOWN_STRING = 16 * 1024

const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie)/i

export interface CodexSessionMetadata {
  nativeSessionId: string
  cwd?: string
  cliVersion?: string
}

export interface CodexStoredEnvelope {
  entry: Record<string, unknown>
  session: CodexSessionMetadata
}

export function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`
}

function sanitizeUnknown(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[max-depth]'
  if (typeof value === 'string') return truncate(value, MAX_UNKNOWN_STRING)
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitizeUnknown(item, depth + 1))
  if (typeof value !== 'object') return String(value)

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeUnknown(item, depth + 1)
  }
  return output
}

export function messageText(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) {
    if (!blocks || typeof blocks !== 'object') return ''
    const item = blocks as Record<string, unknown>
    for (const key of ['text', 'input_text', 'output_text', 'content', 'refusal']) {
      const value = item[key]
      if (typeof value === 'string') return value
      if (Array.isArray(value)) return messageText(value)
    }
    return ''
  }
  return blocks.map(messageText).filter(Boolean).join('\n\n')
}

export function isInjectedContext(role: string, text: string): boolean {
  return role === 'developer'
    || text.startsWith('<environment_context')
    || text.startsWith('<permissions instructions')
}

export function sanitizeCodexEntry(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    return { type: 'malformed', payload: sanitizeUnknown(raw) }
  }

  const entry = raw as Record<string, unknown>
  const type = typeof entry.type === 'string' ? entry.type : 'unknown'
  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined
  const payload = entry.payload && typeof entry.payload === 'object'
    ? entry.payload as Record<string, unknown>
    : {}

  let safePayload: Record<string, unknown>
  if (type === 'session_meta') {
    safePayload = {
      id: payload.id,
      cwd: payload.cwd,
      originator: payload.originator,
      cli_version: payload.cli_version,
    }
  } else if (type === 'response_item' && payload.type === 'message') {
    const role = typeof payload.role === 'string' ? payload.role : 'unknown'
    const text = truncate(messageText(payload.content), MAX_TEXT)
    safePayload = {
      type: 'message',
      role,
      id: payload.id,
      text: isInjectedContext(role, text) ? '[redacted:injected-context]' : text,
      injectedContext: isInjectedContext(role, text),
    }
  } else if (type === 'response_item' && payload.type === 'function_call') {
    safePayload = {
      type: 'function_call',
      id: payload.id,
      name: payload.name,
      call_id: payload.call_id,
      arguments: typeof payload.arguments === 'string'
        ? truncate(payload.arguments, MAX_TOOL_PAYLOAD)
        : sanitizeUnknown(payload.arguments),
    }
  } else if (type === 'response_item' && payload.type === 'function_call_output') {
    safePayload = {
      type: 'function_call_output',
      id: payload.id,
      call_id: payload.call_id,
      output: typeof payload.output === 'string'
        ? truncate(payload.output, MAX_TOOL_PAYLOAD)
        : sanitizeUnknown(payload.output),
    }
  } else if (type === 'response_item' && payload.type === 'web_search_call') {
    safePayload = sanitizeUnknown(payload) as Record<string, unknown>
  } else if (type === 'response_item' && payload.type === 'reasoning') {
    safePayload = {
      type: 'reasoning',
      id: payload.id,
      text: truncate(messageText(payload.summary ?? payload.content ?? payload.text), MAX_TEXT),
    }
  } else {
    safePayload = sanitizeUnknown(payload) as Record<string, unknown>
  }

  return {
    ...(timestamp ? { timestamp } : {}),
    type,
    payload: safePayload,
  }
}

export function nativeIdForEntry(entry: Record<string, unknown>): string | undefined {
  const payload = entry.payload && typeof entry.payload === 'object'
    ? entry.payload as Record<string, unknown>
    : {}
  for (const candidate of [payload.id, payload.call_id, payload.turn_id]) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return undefined
}

export function nativeTypeForEntry(entry: Record<string, unknown>): string {
  const top = typeof entry.type === 'string' ? entry.type : 'unknown'
  const payload = entry.payload && typeof entry.payload === 'object'
    ? entry.payload as Record<string, unknown>
    : {}
  const inner = typeof payload.type === 'string' ? payload.type : undefined
  return inner ? `${top}/${inner}` : top
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
    ...(body ? { output: truncate(body, MAX_TOOL_PAYLOAD) } : {}),
  }
}
