import type { LiveEventDto, LiveRuntimeEventDto } from '@agent-lens/protocol'
import { agentLensI18n } from '../i18n/runtime'
import type { TaskRoundModel } from './task-detail-model'

export type LiveTaskProjectionItem =
  | {
      id: string
      kind: 'message'
      role: 'user' | 'assistant'
      text: string
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

/**
 * Snapshot entries stay adapter/native-owned. The Product Surface only consumes
 * stable message-shaped fields when they are present and ignores unknown rows.
 */
export function projectLiveSnapshotEntries(entries: readonly unknown[]): LiveTaskProjectionItem[] {
  return entries.flatMap((value, index) => {
    const item = record(value)
    const nested = record(item.message)
    const role = messageRole(item.role) ?? messageRole(nested.role)
    if (!role) return []
    const body = contentText(item.content)
      || contentText(item.text)
      || contentText(nested.content)
      || contentText(nested.text)
    if (!body) return []
    const id = text(item.id) || text(item.message_id) || text(nested.id) || `snapshot-message-${index}`
    const at = text(item.created_at) || text(item.createdAt) || text(item.timestamp)
    return [{
      id,
      kind: 'message' as const,
      role,
      text: body,
      streaming: false,
      ...(at ? { at } : {}),
    }]
  })
}

function contentId(event: LiveEventDto, kind: 'message' | 'thinking', fallback: string): string {
  if ('messageId' in event && event.messageId) return `${kind}:${event.messageId}:${'contentIndex' in event ? event.contentIndex ?? 0 : 0}`
  if ('contentIndex' in event && event.contentIndex !== undefined) return `${kind}:content:${event.contentIndex}`
  return `${kind}:${fallback}`
}

function upsertMessage(
  items: readonly LiveTaskProjectionItem[],
  id: string,
  updater: (current: Extract<LiveTaskProjectionItem, { kind: 'message' }> | undefined) => Extract<LiveTaskProjectionItem, { kind: 'message' }>,
): LiveTaskProjectionItem[] {
  const index = items.findIndex(item => item.kind === 'message' && item.id === id)
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
  const index = items.findIndex(item => item.kind === 'thinking' && item.id === id)
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
  const index = items.findIndex(item => item.kind === 'tool' && item.callId === callId)
  const current = index >= 0 ? items[index] as Extract<LiveTaskProjectionItem, { kind: 'tool' }> : undefined
  const next = updater(current)
  if (index < 0) return [...items, next]
  const copy = [...items]
  copy[index] = next
  return copy
}

function settle(items: readonly LiveTaskProjectionItem[]): LiveTaskProjectionItem[] {
  return items.map(item => {
    if (item.kind === 'message' && item.streaming) return { ...item, streaming: false }
    if (item.kind === 'thinking' && item.streaming) return { ...item, streaming: false }
    if (item.kind === 'tool' && item.status === 'running') return { ...item, status: 'success' as const }
    return item
  })
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

  if (event.type === 'completed') return settle(items)
  return [...items]
}


export interface LiveTaskRoundProjection {
  model: TaskRoundModel
  items: LiveTaskProjectionItem[]
}

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
  const previewSource = items.find(item => item.kind === 'message' && item.role === 'user')
    ?? items.find(item => item.kind === 'message')
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
): LiveTaskRoundProjection[] {
  const raw: Array<{ id: string; ordinal?: number; background: boolean; items: LiveTaskProjectionItem[] }> = []
  let current: { id: string; ordinal?: number; background: boolean; items: LiveTaskProjectionItem[] } | undefined
  let ordinal = 0

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

  return raw.map(round => ({
    model: buildRoundModel(round.items, round.ordinal, round.id, round.background),
    items: round.items,
  }))
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
): LiveTaskProjectionItem[] {
  const value = textValue.trim()
  if (!value) return [...items]
  return [...items, {
    id,
    kind: 'message',
    role: 'user',
    text: value,
    streaming: false,
  }]
}
