/** Source-backed view of the official Pi subagent extension's toolResult.details.
 * One tool may contain multiple results (single / parallel / chain), plus the
 * extension's workflow / management envelopes. These are tool-local results,
 * NOT native sessions or navigable children.
 */
export type PiSubagentMode = 'single' | 'parallel' | 'chain' | 'workflow' | 'management'
export type PiSubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | 'unknown'

/** Snapshot child inventory from the extension's WorkflowChildSummaryV1. */
export type PiWorkflowChildState = 'pending' | 'running' | 'completed' | 'failed'
  | 'paused' | 'stopped' | 'rejected' | 'detached'
export type PiWorkflowState = 'queued' | 'running' | 'completed' | 'failed' | 'paused' | 'stopped'

export interface PiWorkflowChild {
  childId: string
  state: PiWorkflowChildState
  runId?: string
  agent?: string
  sessionName?: string
  model?: string
  thinking?: string
}

export interface PiWorkflowChildren {
  inventoryComplete: boolean
  workflowState: PiWorkflowState
  children: readonly PiWorkflowChild[]
}

export interface PiSubagentToolDetails {
  mode: PiSubagentMode
  results: readonly unknown[]
  /** Present only when the official versioned envelope validates. */
  workflowChildren?: PiWorkflowChildren
}

export interface PiSubagentSummary {
  /** workflowChildren proves workflow context even when dispatch mode is single. */
  mode: PiSubagentMode
  /** Absent while an inventory is still assembling; never invented from a broken envelope. */
  count?: number
  workflowState?: PiWorkflowState
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
export function isPiSubagentTool(
  toolName: string,
  toolSourceType?: string,
  mcpServerId?: string,
): boolean {
  return toolName === 'subagent' && toolSourceType !== 'mcp' && !mcpServerId?.trim()
}

const SUBAGENT_MODES: readonly PiSubagentMode[] = ['single', 'parallel', 'chain', 'workflow', 'management']
const WORKFLOW_CHILD_STATES: readonly PiWorkflowChildState[] =
  ['pending', 'running', 'completed', 'failed', 'paused', 'stopped', 'rejected', 'detached']
const WORKFLOW_STATES: readonly PiWorkflowState[] =
  ['queued', 'running', 'completed', 'failed', 'paused', 'stopped']

function optionalText(value: unknown, key: string): { [key: string]: string } | undefined {
  const parsed = text(value)
  return parsed ? { [key]: parsed } : undefined
}

/** Only the official versioned WorkflowChildSummaryV1 envelope is accepted;
 * an unknown version or a malformed child drops the whole snapshot instead of
 * inventing child states, while mode/results stay independently valid. */
function piWorkflowChildren(value: unknown): PiWorkflowChildren | undefined {
  const source = record(value)
  if (!source || source.version !== 1) return undefined
  if (typeof source.inventoryComplete !== 'boolean') return undefined
  if (typeof source.workflowState !== 'string'
    || !WORKFLOW_STATES.includes(source.workflowState as PiWorkflowState)) return undefined
  if (!Array.isArray(source.children)) return undefined
  const children: PiWorkflowChild[] = []
  for (const entry of source.children) {
    const child = record(entry)
    if (!child) return undefined
    const childId = text(child.childId)
    if (!childId || typeof child.state !== 'string'
      || !WORKFLOW_CHILD_STATES.includes(child.state as PiWorkflowChildState)) return undefined
    children.push({
      childId,
      state: child.state as PiWorkflowChildState,
      ...optionalText(child.runId, 'runId'),
      ...optionalText(child.agent, 'agent'),
      ...optionalText(child.sessionName, 'sessionName'),
      ...optionalText(child.model, 'model'),
      ...optionalText(child.thinking, 'thinking'),
    })
  }
  return {
    inventoryComplete: source.inventoryComplete,
    workflowState: source.workflowState as PiWorkflowState,
    children,
  }
}

export function piSubagentToolDetails(toolName: string, value: unknown): PiSubagentToolDetails | undefined {
  if (toolName !== 'subagent') return undefined
  const details = record(value)
  if (!details || !Array.isArray(details.results)) return undefined
  if (!SUBAGENT_MODES.includes(details.mode as PiSubagentMode)) return undefined
  const workflowChildren = piWorkflowChildren(details.workflowChildren)
  return {
    mode: details.mode as PiSubagentMode,
    results: details.results,
    ...(workflowChildren ? { workflowChildren } : {}),
  }
}

/** Collapsed-row label data. An inventory that is still assembling (empty +
 * incomplete) omits the count instead of reporting 0, and management calls
 * never claim child tasks. */
export function piSubagentSummary(details: PiSubagentToolDetails): PiSubagentSummary {
  const workflowChildren = details.workflowChildren
  if (workflowChildren) {
    const count = workflowChildren.children.length > 0 || workflowChildren.inventoryComplete
      ? workflowChildren.children.length
      : undefined
    return {
      mode: 'workflow',
      ...(count !== undefined ? { count } : {}),
      workflowState: workflowChildren.workflowState,
    }
  }
  const count = details.mode !== 'management' && details.results.length > 0
    ? details.results.length
    : undefined
  return { mode: details.mode, ...(count !== undefined ? { count } : {}) }
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
  const original = Array.isArray(message.content) ? message.content
    : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : []
  const parts: PiSubagentTranscriptPart[] = []
  let skipped = 0
  for (const value of original.slice(0, 40)) {
    const block = record(value)
    if (!block) { skipped++; continue }
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
    } else { skipped++; continue }
    parts.push({ kind, text: full.slice(0, 16_384), truncated: full.length > 16_384 })
  }
  return { role: message.role, parts, omittedParts: skipped + Math.max(0, original.length - 40) }
}
