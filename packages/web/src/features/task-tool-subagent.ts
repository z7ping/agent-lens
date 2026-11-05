/** Source-backed view of the official Pi subagent extension's toolResult.details.
 * One tool may contain multiple results (single / parallel / chain).
 * These are tool-local results, NOT native sessions or navigable children.
 */
export type PiSubagentMode = 'single' | 'parallel' | 'chain'
export type PiSubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | 'unknown'

export interface PiSubagentToolDetails {
  mode: PiSubagentMode
  results: readonly unknown[]
}

export interface PiSubagentResult {
  agent: string
  status: PiSubagentStatus
  task?: string
  model?: string
  step?: number
  errorMessage?: string
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; turns?: number }
  messages: readonly unknown[]
}

export interface PiSubagentTranscriptPart {
  kind: 'text' | 'thinking' | 'toolCall'
  text: string
  truncated: boolean
}

export interface PiSubagentTranscriptMessage {
  role: 'user' | 'assistant' | 'toolResult'
  parts: PiSubagentTranscriptPart[]
  omittedParts: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** Exact tool name AND the official mode/results envelope are required.
 * This does not infer an agent relationship from an arbitrary nested object. */
export function piSubagentToolDetails(toolName: string, value: unknown): PiSubagentToolDetails | undefined {
  if (toolName !== 'subagent') return undefined
  const details = record(value)
  if (!details || !Array.isArray(details.results)) return undefined
  if (details.mode !== 'single' && details.mode !== 'parallel' && details.mode !== 'chain') return undefined
  return { mode: details.mode, results: details.results }
}

export function piSubagentResult(value: unknown): PiSubagentResult | undefined {
  const source = record(value)
  if (!source || !text(source.agent)) return undefined
  const status = source.status === 'pending' || source.status === 'running'
    || source.status === 'completed' || source.status === 'failed' || source.status === 'aborted'
      ? source.status : 'unknown'
  const usage = record(source.usage)
  const numbers = usage ? {
    ...(nonnegative(usage.input) !== undefined ? { input: nonnegative(usage.input) } : {}),
    ...(nonnegative(usage.output) !== undefined ? { output: nonnegative(usage.output) } : {}),
    ...(nonnegative(usage.cacheRead) !== undefined ? { cacheRead: nonnegative(usage.cacheRead) } : {}),
    ...(nonnegative(usage.cacheWrite) !== undefined ? { cacheWrite: nonnegative(usage.cacheWrite) } : {}),
    ...(nonnegative(usage.cost) !== undefined ? { cost: nonnegative(usage.cost) } : {}),
    ...(nonnegative(usage.turns) !== undefined ? { turns: nonnegative(usage.turns) } : {}),
  } : undefined
  return {
    agent: text(source.agent)!,
    status,
    ...(text(source.task) ? { task: text(source.task) } : {}),
    ...(text(source.model) ? { model: text(source.model) } : {}),
    ...(Number.isSafeInteger(source.step) && Number(source.step) >= 0 ? { step: Number(source.step) } : {}),
    ...(text(source.errorMessage) ? { errorMessage: text(source.errorMessage) } : {}),
    ...(numbers && Object.keys(numbers).length ? { usage: numbers } : {}),
    messages: Array.isArray(source.messages) ? source.messages : [],
  }
}

/** Decode only the opened transcript page; never project an entire child
 * transcript just to draw a collapsed tool, and never fabricate message IDs. */
export function piSubagentTranscriptMessage(value: unknown): PiSubagentTranscriptMessage | undefined {
  const message = record(value)
  if (!message || (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult')) return undefined
  const original = Array.isArray(message.content) ? message.content : []
  const parts: PiSubagentTranscriptPart[] = []
  for (const value of original.slice(0, 40)) {
    const block = record(value)
    if (!block) continue
    let kind: PiSubagentTranscriptPart['kind']
    let full: string
    if (block.type === 'text' && typeof block.text === 'string') {
      kind = 'text'; full = block.text
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      kind = 'thinking'; full = block.thinking
    } else if (block.type === 'toolCall' && text(block.name)) {
      kind = 'toolCall'
      let args = ''
      try { args = block.arguments === undefined ? '' : JSON.stringify(block.arguments, null, 2) ?? '' }
      catch { args = '' }
      full = text(block.name)! + (args ? '\n' + args : '')
    } else continue
    parts.push({ kind, text: full.slice(0, 16_384), truncated: full.length > 16_384 })
  }
  return { role: message.role, parts, omittedParts: Math.max(0, original.length - 40) }
}
