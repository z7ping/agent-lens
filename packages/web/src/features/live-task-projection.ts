import { reviewMessageAttachmentsFromPayload, type LiveEventDto, type LiveRuntimeEventDto, type ReviewMessageAttachmentDto } from '@agent-lens/protocol'
import { agentLensI18n } from '../i18n/runtime'
import type { TaskRoundModel } from './task-detail-model'

export type LiveTaskProjectionAttachment = ReviewMessageAttachmentDto & {
  /** Web-local optimistic preview; persisted snapshots continue to use dataUrl. */
  previewUrl?: string | undefined
}

export type LiveTaskProjectionItem =
  | {
      id: string
      kind: 'message'
      role: 'user' | 'assistant'
      text: string
      /** Stable native session entry id; present only for snapshot-backed messages. */
      entryId?: string | undefined
      attachments?: LiveTaskProjectionAttachment[] | undefined
      streaming: boolean
      at?: string | undefined
    }
  | {
      id: string
      kind: 'thinking'
      text: string
      streaming: boolean
      at?: string | undefined
    }
  | {
      id: string
      kind: 'tool'
      callId: string
      name: string
      inputPreview?: string | undefined
      output?: string | undefined
      status: 'running' | 'success' | 'error'
      durationMs?: number | undefined
      at?: string | undefined
    }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (typeof item === 'string') return [item]
      const part = record(item)
      const candidate = text(part.text) || text(part.content) || text(part.value)
      return candidate ? [candidate] : []
    }).join('\n')
  }
  const item = record(value)
  return text(item.text) || text(item.content) || text(item.value)
}

function messageRole(value: unknown): 'user' | 'assistant' | null {
  return value === 'user' || value === 'assistant' ? value : null
}

function messageAttachments(
  item: Record<string, unknown>,
  nested: Record<string, unknown>,
): ReviewMessageAttachmentDto[] {
  const attachments: ReviewMessageAttachmentDto[] = []
  const append = (values: readonly ReviewMessageAttachmentDto[]) => {
    for (const value of values) {
      const key = JSON.stringify(value)
      if (!attachments.some(existing => JSON.stringify(existing) === key)) attachments.push(value)
    }
  }

  append(reviewMessageAttachmentsFromPayload(item))
  append(reviewMessageAttachmentsFromPayload(nested))

  for (const content of [item.content, nested.content]) {
    if (!Array.isArray(content)) continue
    const nonTextContent = content.filter(value => {
      const part = record(value)
      const type = text(part.type)
      return type === 'image' || type === 'file'
    })
    if (nonTextContent.length) {
      append(reviewMessageAttachmentsFromPayload({ nonTextContent }))
    }
  }
  return attachments
}

/**
 * Snapshot entries remain adapter/native-owned for compatibility, but the
 * Product Surface only consumes agent-neutral structural shapes: messages,
 * reasoning blocks and tool calls/results. No agent id/name branches belong
 * here.
 */
export function projectLiveSnapshotEntries(entries: readonly unknown[]): LiveTaskProjectionItem[] {
  const projected: LiveTaskProjectionItem[] = []
  const tools = new Map<string, number>()

  const pushTool = (item: Extract<LiveTaskProjectionItem, { kind: 'tool' }>) => {
    const existingIndex = tools.get(item.callId)
    if (existingIndex === undefined) {
      tools.set(item.callId, projected.length)
      projected.push(item)
      return
    }
    const current = projected[existingIndex]
    if (!current || current.kind !== 'tool') return
    projected[existingIndex] = {
      ...current,
      ...item,
      name: item.name === 'tool' ? current.name : item.name,
      inputPreview: item.inputPreview ?? current.inputPreview,
      output: item.output ?? current.output,
    }
  }

  entries.forEach((value, entryIndex) => {
    const item = record(value)
    const nested = record(item.message)
    const rawRole = text(item.role) || text(nested.role)
    const nativeEntryId = item.type === 'message' ? text(item.id) : ''
    const baseId = text(item.id) || text(item.message_id) || text(nested.id) || `snapshot-${entryIndex}`
    const at = text(item.created_at) || text(item.createdAt) || text(item.timestamp)
    const content = Array.isArray(nested.content)
      ? nested.content
      : Array.isArray(item.content)
        ? item.content
        : undefined

    const toolResult = rawRole === 'toolResult' || rawRole === 'tool_result'
    if (toolResult) {
      const callId = text(nested.toolCallId) || text(nested.tool_call_id) || text(item.toolCallId) || text(item.tool_call_id)
      if (!callId) return
      const output = contentText(nested.content) || contentText(item.content) || text(nested.output) || text(item.output)
      pushTool({
        id: `tool:${callId}`,
        kind: 'tool',
        callId,
        name: text(nested.toolName) || text(nested.tool_name) || text(item.toolName) || text(item.tool_name) || 'tool',
        status: nested.isError === true || item.isError === true ? 'error' : 'success',
        ...(output ? { output } : {}),
        ...(at ? { at } : {}),
      })
      return
    }

    const role = messageRole(rawRole)
    if (!role) return

    if (role === 'user') {
      const body = contentText(item.content)
        || contentText(item.text)
        || contentText(nested.content)
        || contentText(nested.text)
      const attachments = messageAttachments(item, nested)
      if (!body && !attachments.length) return
      projected.push({
        id: baseId,
        kind: 'message',
        role,
        text: body,
        ...(nativeEntryId ? { entryId: nativeEntryId } : {}),
        ...(attachments.length ? { attachments } : {}),
        streaming: false,
        ...(at ? { at } : {}),
      })
      return
    }

    if (!content) {
      const body = contentText(item.content)
        || contentText(item.text)
        || contentText(nested.content)
        || contentText(nested.text)
      if (!body) return
      projected.push({
        id: baseId,
        kind: 'message',
        role: 'assistant',
        text: body,
        ...(nativeEntryId ? { entryId: nativeEntryId } : {}),
        streaming: false,
        ...(at ? { at } : {}),
      })
      return
    }

    content.forEach((rawPart, contentIndex) => {
      if (typeof rawPart === 'string') {
        if (!rawPart) return
        projected.push({
          id: `${baseId}:content:${contentIndex}`,
          kind: 'message',
          role: 'assistant',
          text: rawPart,
          streaming: false,
          ...(at ? { at } : {}),
        })
        return
      }

      const part = record(rawPart)
      const type = text(part.type)
      if (type === 'text') {
        const value = text(part.text) || text(part.content) || text(part.value)
        if (!value) return
        projected.push({
          id: content.length === 1 ? baseId : `${baseId}:content:${contentIndex}`,
          kind: 'message',
          role: 'assistant',
          text: value,
          streaming: false,
          ...(at ? { at } : {}),
        })
        return
      }

      if (type === 'thinking' || type === 'reasoning') {
        const value = text(part.thinking) || text(part.reasoning) || text(part.text) || text(part.content)
        if (!value) return
        projected.push({
          id: `${baseId}:thinking:${contentIndex}`,
          kind: 'thinking',
          text: value,
          streaming: false,
          ...(at ? { at } : {}),
        })
        return
      }

      if (type === 'toolCall' || type === 'tool_call' || type === 'tool-use' || type === 'tool_use') {
        const callId = text(part.id) || text(part.callId) || text(part.call_id) || `${baseId}:tool:${contentIndex}`
        const name = text(part.name) || text(part.toolName) || text(part.tool_name) || 'tool'
        const input = part.arguments ?? part.input ?? part.params
        let inputPreview = ''
        if (typeof input === 'string') inputPreview = input
        else if (input !== undefined) {
          try { inputPreview = JSON.stringify(input) ?? '' } catch { inputPreview = String(input) }
        }
        pushTool({
          id: `tool:${callId}`,
          kind: 'tool',
          callId,
          name,
          ...(inputPreview ? { inputPreview } : {}),
          status: 'running',
          ...(at ? { at } : {}),
        })
      }
    })
  })

  return projected
}

function contentId(event: LiveEventDto, kind: 'message' | 'thinking', fallback: string): string {
  if ('messageId' in event && event.messageId) return `${kind}:${event.messageId}:${'contentIndex' in event ? event.contentIndex ?? 0 : 0}`
  if ('contentIndex' in event && event.contentIndex !== undefined) return `${kind}:content:${event.contentIndex}`
  return `${kind}:${fallback}`
}

export function mergeLiveActiveProjectionItems(
  previous: readonly LiveTaskProjectionItem[],
  incoming: readonly LiveTaskProjectionItem[],
): LiveTaskProjectionItem[] {
  const merged = [...previous]
  const indexes = new Map(merged.map((item, index) => [item.id, index] as const))

  for (const item of incoming) {
    // A live SSE update can arrive while reconnect recovery is reading a snapshot.
    // Existing exact IDs are therefore newer presentation state and must win.
    if (indexes.has(item.id)) continue

    // Reconcile a persisted user row with its local optimistic placeholder.
    if (item.kind === 'message' && item.role === 'user') {
      const optimisticIndex = merged.findIndex(candidate =>
        candidate.kind === 'message'
        && candidate.role === 'user'
        && candidate.id.startsWith('user:')
        && candidate.text === item.text,
      )
      if (optimisticIndex >= 0) {
        indexes.delete(merged[optimisticIndex]!.id)
        merged[optimisticIndex] = item
        indexes.set(item.id, optimisticIndex)
        continue
      }
    }

    indexes.set(item.id, merged.length)
    merged.push(item)
  }
  return merged
}

function findLastProjectionIndex(
  items: readonly LiveTaskProjectionItem[],
  predicate: (item: LiveTaskProjectionItem) => boolean,
): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index
  }
  return -1
}

function upsertMessage(
  items: readonly LiveTaskProjectionItem[],
  id: string,
  updater: (current: Extract<LiveTaskProjectionItem, { kind: 'message' }> | undefined) => Extract<LiveTaskProjectionItem, { kind: 'message' }>,
): LiveTaskProjectionItem[] {
  const index = findLastProjectionIndex(items, item => item.kind === 'message' && item.id === id)
  const current = index >= 0 ? items[index] as Extract<LiveTaskProjectionItem, { kind: 'message' }> : undefined
  const next = updater(current)
  if (index < 0) return [...items, next]
  const copy = [...items]
  copy[index] = next
  return copy
}

function upsertThinking(
  items: readonly LiveTaskProjectionItem[],
  id: string,
  updater: (current: Extract<LiveTaskProjectionItem, { kind: 'thinking' }> | undefined) => Extract<LiveTaskProjectionItem, { kind: 'thinking' }>,
): LiveTaskProjectionItem[] {
  const index = findLastProjectionIndex(items, item => item.kind === 'thinking' && item.id === id)
  const current = index >= 0 ? items[index] as Extract<LiveTaskProjectionItem, { kind: 'thinking' }> : undefined
  const next = updater(current)
  if (index < 0) return [...items, next]
  const copy = [...items]
  copy[index] = next
  return copy
}

function upsertTool(
  items: readonly LiveTaskProjectionItem[],
  callId: string,
  updater: (current: Extract<LiveTaskProjectionItem, { kind: 'tool' }> | undefined) => Extract<LiveTaskProjectionItem, { kind: 'tool' }>,
): LiveTaskProjectionItem[] {
  const index = findLastProjectionIndex(items, item => item.kind === 'tool' && item.callId === callId)
  const current = index >= 0 ? items[index] as Extract<LiveTaskProjectionItem, { kind: 'tool' }> : undefined
  const next = updater(current)
  if (index < 0) return [...items, next]
  const copy = [...items]
  copy[index] = next
  return copy
}

export function settleLiveTaskProjectionItems(items: readonly LiveTaskProjectionItem[]): LiveTaskProjectionItem[] {
  return items.map(item => {
    if (item.kind === 'message' && item.streaming) return { ...item, streaming: false }
    if (item.kind === 'thinking' && item.streaming) return { ...item, streaming: false }
    if (item.kind === 'tool' && item.status === 'running') return { ...item, status: 'success' as const }
    return item
  })
}

export function liveEventChangesTaskTranscript(event: LiveEventDto | undefined): boolean {
  if (!event) return false
  return event.type === 'text.start'
    || event.type === 'text.delta'
    || event.type === 'text.end'
    || event.type === 'reasoning.start'
    || event.type === 'reasoning.delta'
    || event.type === 'reasoning.end'
    || event.type === 'tool.start'
    || event.type === 'tool.output'
    || event.type === 'tool.end'
    || event.type === 'completed'
}

export function reduceLiveTaskEvent(
  items: readonly LiveTaskProjectionItem[],
  envelope: Pick<LiveRuntimeEventDto, 'sequence' | 'receivedAt' | 'normalizedEvent'>,
): LiveTaskProjectionItem[] {
  const event = envelope.normalizedEvent
  if (!event) return [...items]
  const fallback = String(envelope.sequence)

  if (event.type === 'text.start' || event.type === 'text.delta' || event.type === 'text.end') {
    const id = contentId(event, 'message', fallback)
    return upsertMessage(items, id, current => ({
      id,
      kind: 'message',
      role: 'assistant',
      text: event.type === 'text.delta'
        ? `${current?.text ?? ''}${event.delta ?? ''}`
        : event.text ?? current?.text ?? '',
      streaming: event.type !== 'text.end',
      at: current?.at ?? envelope.receivedAt,
    }))
  }

  if (event.type === 'reasoning.start' || event.type === 'reasoning.delta' || event.type === 'reasoning.end') {
    const id = contentId(event, 'thinking', fallback)
    return upsertThinking(items, id, current => ({
      id,
      kind: 'thinking',
      text: event.type === 'reasoning.delta'
        ? `${current?.text ?? ''}${event.delta ?? ''}`
        : event.text ?? current?.text ?? '',
      streaming: event.type !== 'reasoning.end',
      at: current?.at ?? envelope.receivedAt,
    }))
  }

  if (event.type === 'tool.start') {
    const callId = event.callId || `sequence-${fallback}`
    return upsertTool(items, callId, current => ({
      id: current?.id ?? `tool:${callId}`,
      kind: 'tool',
      callId,
      name: event.name || current?.name || 'tool',
      inputPreview: event.inputPreview ?? current?.inputPreview,
      output: current?.output,
      status: 'running',
      at: current?.at ?? envelope.receivedAt,
    }))
  }

  if (event.type === 'tool.output') {
    const callId = event.callId || `sequence-${fallback}`
    return upsertTool(items, callId, current => ({
      id: current?.id ?? `tool:${callId}`,
      kind: 'tool',
      callId,
      name: event.name || current?.name || 'tool',
      inputPreview: current?.inputPreview,
      output: event.output,
      status: current?.status ?? 'running',
      at: current?.at ?? envelope.receivedAt,
    }))
  }

  if (event.type === 'tool.end') {
    const callId = event.callId || `sequence-${fallback}`
    return upsertTool(items, callId, current => ({
      id: current?.id ?? `tool:${callId}`,
      kind: 'tool',
      callId,
      name: event.name || current?.name || 'tool',
      inputPreview: current?.inputPreview,
      output: event.output ?? current?.output,
      status: event.status,
      durationMs: event.durationMs,
      at: current?.at ?? envelope.receivedAt,
    }))
  }

  if (event.type === 'completed') return settleLiveTaskProjectionItems(items)
  return [...items]
}


export interface LiveTaskRoundProjection {
  model: TaskRoundModel
  items: LiveTaskProjectionItem[]
}

export interface LiveTaskRoundSegments {
  stable: LiveTaskRoundProjection[]
  active: LiveTaskRoundProjection[]
}

export const LIVE_TASK_ROUND_FACT_LIMIT = 8

function compactRoundPreview(value: string, max = 120): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function roundTiming(items: readonly LiveTaskProjectionItem[]): { durationMs: number; startedAtMs?: number } {
  const times = items
    .flatMap(item => item.at ? [Date.parse(item.at)] : [])
    .filter(Number.isFinite)
  if (!times.length) return { durationMs: 0 }
  const startedAtMs = Math.min(...times)
  const endedAtMs = Math.max(...times)
  return { durationMs: Math.max(0, endedAtMs - startedAtMs), startedAtMs }
}

function buildRoundModel(
  items: readonly LiveTaskProjectionItem[],
  ordinal: number | undefined,
  id: string,
  background = false,
): TaskRoundModel {
  const timing = roundTiming(items)
  const previewSource = items.find(
    (item): item is Extract<LiveTaskProjectionItem, { kind: 'message' }> =>
      item.kind === 'message' && item.role === 'user',
  ) ?? items.find(
    (item): item is Extract<LiveTaskProjectionItem, { kind: 'message' }> => item.kind === 'message',
  )
  const toolCount = items.filter(item => item.kind === 'tool').length
  const errorCount = items.filter(item => item.kind === 'tool' && item.status === 'error').length
  const running = items.some(item =>
    (item.kind === 'message' || item.kind === 'thinking') ? item.streaming : item.status === 'running',
  )
  return {
    id,
    semanticId: id,
    ...(ordinal !== undefined ? { ordinal } : {}),
    label: background
      ? agentLensI18n.t('task:surface.backgroundActivity')
      : agentLensI18n.t('task:surface.roundOrdinal', { count: ordinal ?? 1 }),
    state: running ? 'running' : 'settled',
    ...(previewSource ? { preview: compactRoundPreview(previewSource.text) } : {}),
    toolCount,
    errorCount,
    durationMs: timing.durationMs,
    highLatency: false,
  }
}

/**
 * Product-level round projection. A user message starts a new semantic round;
 * following assistant/thinking/tool items stay in that round until the next
 * user message. Items before the first user message are kept as background
 * activity so TaskSurface can still expose them without inventing agent logic.
 */
export function projectLiveTaskRounds(
  items: readonly LiveTaskProjectionItem[],
  ordinalOffset = 0,
): LiveTaskRoundProjection[] {
  const raw: Array<{ id: string; ordinal?: number; background: boolean; items: LiveTaskProjectionItem[] }> = []
  let current: { id: string; ordinal?: number; background: boolean; items: LiveTaskProjectionItem[] } | undefined
  let ordinal = ordinalOffset

  for (const item of items) {
    const startsRound = item.kind === 'message' && item.role === 'user'
    if (startsRound) {
      ordinal += 1
      current = {
        id: `live-round:${item.id}`,
        ordinal,
        background: false,
        items: [],
      }
      raw.push(current)
    } else if (!current) {
      current = {
        id: 'live-round:background',
        background: true,
        items: [],
      }
      raw.push(current)
    }
    current.items.push(item)
  }

  return raw.flatMap(round => {
    const aggregate = buildRoundModel(round.items, round.ordinal, round.id, round.background)
    const fragmentCount = Math.max(1, Math.ceil(round.items.length / LIVE_TASK_ROUND_FACT_LIMIT))
    return Array.from({ length: fragmentCount }, (_, index) => {
      const fragment = round.items.slice(
        index * LIVE_TASK_ROUND_FACT_LIMIT,
        (index + 1) * LIVE_TASK_ROUND_FACT_LIMIT,
      )
      const model = buildRoundModel(fragment, round.ordinal, `${round.id}:${index}`, round.background)
      return {
        model: {
          ...model,
          semanticId: round.id,
          label: index === 0
            ? aggregate.label
            : agentLensI18n.t('task:surface.roundContinuation', { label: aggregate.label }),
          ...(index === 0 && aggregate.preview ? { preview: aggregate.preview } : {}),
          toolCount: index === 0 ? aggregate.toolCount : model.toolCount,
          errorCount: index === 0 ? aggregate.errorCount : model.errorCount,
          durationMs: index === 0 ? aggregate.durationMs : model.durationMs,
        },
        items: fragment,
      }
    })
  })
}

export function liveTaskStableRoundPrefixLength(
  items: readonly LiveTaskProjectionItem[],
  isStreaming: boolean,
): number {
  if (!isStreaming) return items.length
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.kind === 'message' && item.role === 'user') return index
  }
  return 0
}

export class LiveTaskRoundProjector {
  private stableCount = -1
  private stableTail: LiveTaskProjectionItem | undefined
  private stableRounds: LiveTaskRoundProjection[] = []
  private stableOrdinal = 0

  projectSegmented(
    stableItems: readonly LiveTaskProjectionItem[],
    activeItems: readonly LiveTaskProjectionItem[],
  ): LiveTaskRoundSegments {
    const stableCount = stableItems.length
    const stableTail = stableCount > 0 ? stableItems[stableCount - 1] : undefined
    if (this.stableCount !== stableCount || this.stableTail !== stableTail) {
      this.stableCount = stableCount
      this.stableTail = stableTail
      this.stableRounds = projectLiveTaskRounds(stableItems)
      this.stableOrdinal = this.stableRounds.reduce(
        (max, round) => Math.max(max, round.model.ordinal ?? 0),
        0,
      )
    }

    return {
      stable: this.stableRounds,
      active: activeItems.length
        ? projectLiveTaskRounds(activeItems, this.stableOrdinal)
        : [],
    }
  }

  projectSegments(
    stableItems: readonly LiveTaskProjectionItem[],
    activeItems: readonly LiveTaskProjectionItem[],
  ): LiveTaskRoundProjection[] {
    const segments = this.projectSegmented(stableItems, activeItems)
    return segments.active.length
      ? [...segments.stable, ...segments.active]
      : segments.stable
  }

  project(
    items: readonly LiveTaskProjectionItem[],
    requestedStableCount: number,
  ): LiveTaskRoundProjection[] {
    const stableCount = Math.max(0, Math.min(items.length, requestedStableCount))
    return this.projectSegments(
      items.slice(0, stableCount),
      items.slice(stableCount),
    )
  }

  reset(): void {
    this.stableCount = -1
    this.stableTail = undefined
    this.stableRounds = []
    this.stableOrdinal = 0
  }
}

export function liveTaskRoundEstimate(round: LiveTaskRoundProjection): number {
  const messageCount = round.items.filter(item => item.kind === 'message').length
  const thinkingCount = round.items.filter(item => item.kind === 'thinking').length
  const toolCount = round.items.filter(item => item.kind === 'tool').length
  return Math.max(180, Math.min(1200, 120 + messageCount * 120 + thinkingCount * 150 + toolCount * 110))
}

export function projectLiveInputHistory(
  items: readonly LiveTaskProjectionItem[],
  limit = 100,
): string[] {
  const values = items.flatMap(item => item.kind === 'message' && item.role === 'user'
    ? [item.text.trim()]
    : [])
    .filter(Boolean)
  return values.slice(-Math.max(0, limit))
}

export function appendLiveInputHistory(
  history: readonly string[],
  value: string,
  limit = 100,
): string[] {
  const text = value.trim()
  if (!text) return [...history]
  return [...history, text].slice(-Math.max(0, limit))
}

export function appendOptimisticLiveUserMessage(
  items: readonly LiveTaskProjectionItem[],
  textValue: string,
  id = `user:${Date.now()}`,
  attachments: readonly LiveTaskProjectionAttachment[] = [],
): LiveTaskProjectionItem[] {
  const value = textValue.trim()
  if (!value && !attachments.length) return [...items]
  return [...items, {
    id,
    kind: 'message',
    role: 'user',
    text: value,
    ...(attachments.length ? { attachments: [...attachments] } : {}),
    streaming: false,
  }]
}
