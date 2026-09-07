import type { PiLiveHistoryItem } from './pi-live-history'

export interface PiLiveDeltaOptions {
  contentIndex?: number | undefined
  messageEpoch?: number | undefined
  at?: string | undefined
}

export interface PiLiveCurrentToolInput {
  callId: string
  name: string
  summary: string
  output?: string | undefined
  at?: string | undefined
  startedAtMs?: number | undefined
  contentIndex?: number | undefined
}

type PiLiveContentKind = 'text' | 'thinking'

function nextLiveId(items: PiLiveHistoryItem[], kind: 'message' | 'thinking'): string {
  const count = items.filter(item => item.kind === kind).length
  return `pi-live-current:${kind}:${count}`
}

function deltaBlockId(kind: PiLiveContentKind, items: PiLiveHistoryItem[], options: PiLiveDeltaOptions): string {
  const itemKind = kind === 'text' ? 'message' : 'thinking'
  if (options.contentIndex === undefined) return nextLiveId(items, itemKind)
  return `pi-live-current:message-${options.messageEpoch ?? 0}:${itemKind}:${options.contentIndex}`
}

function recoveredDeltaIndex(items: PiLiveHistoryItem[], kind: PiLiveContentKind, contentIndex: number): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (kind === 'text' && item?.kind === 'message' && item.role === 'assistant' && item.contentIndex === contentIndex && item.state === 'running') return index
    if (kind === 'thinking' && item?.kind === 'thinking' && item.contentIndex === contentIndex && item.state === 'running') return index
  }
  return -1
}

function contentBlockIndex(
  items: PiLiveHistoryItem[],
  kind: PiLiveContentKind,
  options: PiLiveDeltaOptions,
): number {
  if (options.contentIndex === undefined) return -1
  const id = deltaBlockId(kind, items, options)
  const exact = items.findIndex(item => item.id === id)
  if (exact >= 0) return exact
  return recoveredDeltaIndex(items, kind, options.contentIndex)
}

function contentText(item: PiLiveHistoryItem | undefined, kind: PiLiveContentKind): string | undefined {
  if (kind === 'text' && item?.kind === 'message' && item.role === 'assistant') return item.text
  if (kind === 'thinking' && item?.kind === 'thinking') return item.text
  return undefined
}

function updateContentBlock(
  items: PiLiveHistoryItem[],
  index: number,
  kind: PiLiveContentKind,
  text: string,
  state: 'running' | 'settled',
): PiLiveHistoryItem[] | null {
  if (index < 0) return null
  const current = items[index]
  const next = [...items]
  if (kind === 'text' && current?.kind === 'message' && current.role === 'assistant') {
    next[index] = { ...current, text, state }
    return next
  }
  if (kind === 'thinking' && current?.kind === 'thinking') {
    next[index] = { ...current, text, state }
    return next
  }
  return null
}

/**
 * `*_start` 就建立空 block。Pi 允许不同 content block 的事件交错；
 * 如果等第一个 delta 才创建，后启动的 tool/text 可能先占位并改变来源顺序。
 */
export function startPiLiveContentBlock(
  items: PiLiveHistoryItem[],
  kind: PiLiveContentKind,
  options: PiLiveDeltaOptions,
  initialText = '',
): PiLiveHistoryItem[] {
  if (options.contentIndex === undefined) return items
  const index = contentBlockIndex(items, kind, options)
  if (index >= 0) {
    const currentText = contentText(items[index], kind)
    if (initialText && !currentText) return updateContentBlock(items, index, kind, initialText, 'running') ?? items
    return items
  }

  const id = deltaBlockId(kind, items, options)
  if (kind === 'text') {
    return [...items, {
      id,
      kind: 'message',
      role: 'assistant',
      text: initialText,
      at: options.at ?? '',
      state: 'running',
      contentIndex: options.contentIndex,
    }]
  }
  return [...items, {
    id,
    kind: 'thinking',
    text: initialText,
    at: options.at ?? '',
    state: 'running',
    contentIndex: options.contentIndex,
  }]
}

export function appendPiLiveDelta(
  items: PiLiveHistoryItem[],
  kind: PiLiveContentKind,
  delta: string,
  options: PiLiveDeltaOptions = {},
): PiLiveHistoryItem[] {
  if (!delta) return items

  if (options.contentIndex !== undefined) {
    const prepared = startPiLiveContentBlock(items, kind, options)
    const index = contentBlockIndex(prepared, kind, options)
    const current = contentText(prepared[index], kind)
    if (current !== undefined) return updateContentBlock(prepared, index, kind, current + delta, 'running') ?? prepared
  }

  const last = items.at(-1)
  if (options.contentIndex === undefined) {
    if (kind === 'text' && last?.kind === 'message' && last.role === 'assistant' && last.state === 'running') {
      return [...items.slice(0, -1), { ...last, text: last.text + delta }]
    }
    if (kind === 'thinking' && last?.kind === 'thinking' && last.state === 'running') {
      return [...items.slice(0, -1), { ...last, text: last.text + delta }]
    }
  }

  const id = deltaBlockId(kind, items, options)
  if (kind === 'text') {
    return [...items, {
      id,
      kind: 'message',
      role: 'assistant',
      text: delta,
      at: options.at ?? '',
      state: 'running',
      contentIndex: options.contentIndex,
    }]
  }
  return [...items, {
    id,
    kind: 'thinking',
    text: delta,
    at: options.at ?? '',
    state: 'running',
    contentIndex: options.contentIndex,
  }]
}

/** `*_end` 的完整内容是权威值，原位覆盖 delta 聚合结果并结算该 block。 */
export function finishPiLiveContentBlock(
  items: PiLiveHistoryItem[],
  kind: PiLiveContentKind,
  content: string,
  options: PiLiveDeltaOptions,
): PiLiveHistoryItem[] {
  if (options.contentIndex === undefined) return items
  const prepared = startPiLiveContentBlock(items, kind, options, content)
  const index = contentBlockIndex(prepared, kind, options)
  return updateContentBlock(prepared, index, kind, content || contentText(prepared[index], kind) || '', 'settled') ?? prepared
}

export function startPiLiveTool(items: PiLiveHistoryItem[], input: PiLiveCurrentToolInput): PiLiveHistoryItem[] {
  const index = items.findIndex(item => item.kind === 'tool' && item.callId === input.callId)
  const current = index >= 0 ? items[index] : undefined
  const previous = current?.kind === 'tool' ? current : undefined
  const tool: PiLiveHistoryItem = {
    id: previous?.id ?? `pi-live-current:tool:${input.callId}`,
    kind: 'tool',
    callId: input.callId,
    name: input.name || previous?.name || 'tool',
    summary: input.summary || previous?.summary || '',
    output: input.output ?? previous?.output ?? '',
    status: 'running',
    at: input.at ?? previous?.at ?? '',
    startedAtMs: input.startedAtMs ?? previous?.startedAtMs,
    contentIndex: input.contentIndex ?? previous?.contentIndex,
  }
  if (index < 0) return [...items, tool]
  const next = [...items]
  next[index] = tool
  return next
}

export function updatePiLiveTool(items: PiLiveHistoryItem[], callId: string, output: string): PiLiveHistoryItem[] {
  const index = items.findIndex(item => item.kind === 'tool' && item.callId === callId)
  if (index < 0) return items
  const current = items[index]
  if (!current || current.kind !== 'tool') return items
  const next = [...items]
  next[index] = { ...current, output }
  return next
}

export function finishPiLiveTool(
  items: PiLiveHistoryItem[],
  callId: string,
  status: 'success' | 'error',
  output: string,
  endedAtMs = Date.now(),
): PiLiveHistoryItem[] {
  const index = items.findIndex(item => item.kind === 'tool' && item.callId === callId)
  if (index < 0) return items
  const current = items[index]
  if (!current || current.kind !== 'tool') return items
  const durationMs = current.startedAtMs === undefined ? current.durationMs : Math.max(0, endedAtMs - current.startedAtMs)
  const next = [...items]
  next[index] = { ...current, status, output: output || current.output, durationMs }
  return next
}

function isAssistantTerminal(item: PiLiveHistoryItem): boolean {
  return item.kind === 'lifecycle' && ['assistant.stop', 'assistant.error', 'assistant.cancelled'].includes(item.event)
}

export function markPiLiveItemsRunning(items: PiLiveHistoryItem[]): PiLiveHistoryItem[] {
  let lastTerminal = -1
  for (let index = 0; index < items.length; index += 1) {
    if (isAssistantTerminal(items[index]!)) lastTerminal = index
  }
  return items.map((item, index) => {
    if (index > lastTerminal && item.kind === 'message' && item.role === 'assistant') return { ...item, state: 'running' as const }
    if (index > lastTerminal && item.kind === 'thinking') return { ...item, state: 'running' as const }
    if (index > lastTerminal && item.kind === 'tool' && item.status === 'unknown') return { ...item, status: 'running' as const }
    return item
  })
}

export function settlePiLiveItems(items: PiLiveHistoryItem[]): PiLiveHistoryItem[] {
  return items.map(item => {
    if (item.kind === 'message' && item.role === 'assistant' && item.state === 'running') return { ...item, state: 'settled' as const }
    if (item.kind === 'thinking' && item.state === 'running') return { ...item, state: 'settled' as const }
    if (item.kind === 'tool' && item.status === 'running') return { ...item, status: 'unknown' as const }
    return item
  })
}

function semanticKeys(items: PiLiveHistoryItem[]): string[] {
  const counts = new Map<string, number>()
  return items.map(item => {
    if (item.kind === 'tool') return `tool:${item.callId}`
    if (item.kind === 'message') {
      const prefix = item.role === 'assistant' && item.contentIndex !== undefined
        ? `message:assistant:content:${item.contentIndex}`
        : `message:${item.role}`
      const occurrence = counts.get(prefix) ?? 0
      counts.set(prefix, occurrence + 1)
      return `${prefix}:${occurrence}`
    }
    if (item.kind === 'thinking') {
      const prefix = item.contentIndex === undefined ? 'thinking' : `thinking:content:${item.contentIndex}`
      const occurrence = counts.get(prefix) ?? 0
      counts.set(prefix, occurrence + 1)
      return `${prefix}:${occurrence}`
    }
    return `${item.kind}:${item.id}`
  })
}

function settleLiveItem(live: PiLiveHistoryItem, persisted?: PiLiveHistoryItem): PiLiveHistoryItem {
  if (!persisted) return settlePiLiveItems([live])[0] ?? live
  if (live.kind === 'message' && persisted.kind === 'message') {
    return { ...persisted, id: live.id, state: 'settled', contentIndex: live.contentIndex ?? persisted.contentIndex }
  }
  if (live.kind === 'thinking' && persisted.kind === 'thinking') {
    return { ...persisted, id: live.id, state: 'settled', contentIndex: live.contentIndex ?? persisted.contentIndex }
  }
  if (live.kind === 'tool' && persisted.kind === 'tool') {
    return {
      ...persisted,
      id: live.id,
      startedAtMs: live.startedAtMs,
      durationMs: persisted.durationMs ?? live.durationMs,
      contentIndex: live.contentIndex ?? persisted.contentIndex,
    }
  }
  return live
}

/**
 * Snapshot 只负责补齐和确认事实。已经显示的 live block 顺序与 id 永远不因结算改变；
 * Snapshot 独有事实按其原始位置插入到最近的后续 live block 之前。
 */
export function reconcilePiLiveItems(live: PiLiveHistoryItem[], persisted: PiLiveHistoryItem[]): PiLiveHistoryItem[] {
  if (!live.length) return persisted
  if (!persisted.length) return settlePiLiveItems(live)
  const liveKeys = semanticKeys(live)
  const persistedKeys = semanticKeys(persisted)
  const liveKeySet = new Set(liveKeys)
  const persistedByKey = new Map(persistedKeys.map((key, index) => [key, persisted[index]!]))
  const mergedLive = live.map((item, index) => settleLiveItem(item, persistedByKey.get(liveKeys[index]!)))
  const insertsBefore = new Map<string, PiLiveHistoryItem[]>()
  const tail: PiLiveHistoryItem[] = []

  for (let index = 0; index < persisted.length; index += 1) {
    const key = persistedKeys[index]!
    if (liveKeySet.has(key)) continue
    let nextLiveKey: string | undefined
    for (let cursor = index + 1; cursor < persistedKeys.length; cursor += 1) {
      const candidate = persistedKeys[cursor]!
      if (liveKeySet.has(candidate)) {
        nextLiveKey = candidate
        break
      }
    }
    if (!nextLiveKey) {
      tail.push(persisted[index]!)
      continue
    }
    const before = insertsBefore.get(nextLiveKey) ?? []
    before.push(persisted[index]!)
    insertsBefore.set(nextLiveKey, before)
  }

  const result: PiLiveHistoryItem[] = []
  for (let index = 0; index < mergedLive.length; index += 1) {
    const key = liveKeys[index]!
    result.push(...(insertsBefore.get(key) ?? []), mergedLive[index]!)
  }
  result.push(...tail)
  return result
}
