import type { LiveSnapshotDto } from '@agent-lens/protocol'
import { liveApi } from '../client/live'
import { liveTaskStableRoundPrefixLength, type LiveTaskProjectionItem } from './live-task-projection'

/** 限定实时会话的历史快照窗口，滚动锚点只记录可恢复的轮次定位。 */
export const LIVE_TASK_SNAPSHOT_PAGE_LIMIT = 120
export const LIVE_TASK_HISTORY_WINDOW_MAX_PAGES = 5

export interface LiveHistoryPageBlock {
  page: NonNullable<LiveSnapshotDto['page']>
  itemIds: string[]
}

interface LiveReaderAnchor {
  interactionId: string
  offset: number
  scrollTop: number
}

function snapshotPage(snapshot: LiveSnapshotDto): NonNullable<LiveSnapshotDto['page']> {
  return snapshot.page ?? { hasEarlier: false }
}

export function historyPageBlock(
  snapshot: LiveSnapshotDto,
  items: readonly LiveTaskProjectionItem[],
): LiveHistoryPageBlock {
  return {
    page: snapshotPage(snapshot),
    itemIds: items.map(item => item.id),
  }
}

export function aggregateHistoryPage(blocks: readonly LiveHistoryPageBlock[]): NonNullable<LiveSnapshotDto['page']> {
  const first = blocks[0]?.page
  const last = blocks.at(-1)?.page
  if (!first || !last) return { hasEarlier: false }
  return {
    hasEarlier: first.hasEarlier,
    ...(first.before ? { before: first.before } : {}),
    ...(first.first ? { first: first.first } : {}),
    ...(last.last ? { last: last.last } : {}),
    ...((first.rounds || last.rounds) ? {
      rounds: {
        total: Math.max(first.rounds?.total ?? 0, last.rounds?.total ?? 0),
        ...(first.rounds?.firstOrdinal ? { firstOrdinal: first.rounds.firstOrdinal } : {}),
        ...(last.rounds?.lastOrdinal ? { lastOrdinal: last.rounds.lastOrdinal } : {}),
      },
    } : {}),
    ...(last.hasLater ? { hasLater: true } : {}),
    ...(last.after ? { after: last.after } : {}),
  }
}

export function compactHistoryBlocks(
  blocks: LiveHistoryPageBlock[],
  direction: 'older' | 'newer',
): { blocks: LiveHistoryPageBlock[]; removedIds: Set<string> } {
  const next = [...blocks]
  const removedIds = new Set<string>()
  while (next.length > LIVE_TASK_HISTORY_WINDOW_MAX_PAGES) {
    const removed = direction === 'older' ? next.pop() : next.shift()
    for (const id of removed?.itemIds ?? []) removedIds.add(id)
  }
  const retainedIds = new Set(next.flatMap(block => block.itemIds))
  for (const id of retainedIds) removedIds.delete(id)
  return { blocks: next, removedIds }
}

export function refreshLatestHistoryBlock(
  blocks: readonly LiveHistoryPageBlock[],
  projection: { stable: readonly LiveTaskProjectionItem[]; active: readonly LiveTaskProjectionItem[] },
): LiveHistoryPageBlock[] {
  if (!blocks.length) return []
  const next = [...blocks]
  const fixedIds = new Set(next.slice(0, -1).flatMap(block => block.itemIds))
  const itemIds = [...projection.stable, ...projection.active]
    .map(item => item.id)
    .filter(id => !fixedIds.has(id))
  next[next.length - 1] = { ...next[next.length - 1]!, itemIds }
  return next
}

export function captureLiveReaderAnchor(reader: HTMLElement): LiveReaderAnchor {
  const readerTop = reader.getBoundingClientRect().top
  const anchorY = readerTop + Math.min(Math.max(reader.clientHeight * .3, 72), 190)
  const elements = reader.querySelectorAll<HTMLElement>('.virtual-round-shell[data-interaction-id], .task-round[data-interaction-id]')
  let anchor: HTMLElement | null = null
  for (const element of elements) {
    if (element.closest('.task-session-reader') !== reader) continue
    const top = element.getBoundingClientRect().top
    if (top <= anchorY) anchor = element
    else if (!anchor) {
      anchor = element
      break
    } else break
  }
  return {
    interactionId: anchor?.dataset.interactionId ?? '',
    offset: anchor ? anchor.getBoundingClientRect().top - readerTop : 0,
    scrollTop: reader.scrollTop,
  }
}

export function restoreLiveReaderAnchor(reader: HTMLElement, saved: LiveReaderAnchor): void {
  if (!saved.interactionId) {
    reader.scrollTop = saved.scrollTop
    return
  }
  const anchor = [...reader.querySelectorAll<HTMLElement>('.virtual-round-shell[data-interaction-id], .task-round[data-interaction-id]')]
    .find(element => element.dataset.interactionId === saved.interactionId)
  if (!anchor) {
    reader.scrollTop = saved.scrollTop
    return
  }
  const readerTop = reader.getBoundingClientRect().top
  reader.scrollTop += anchor.getBoundingClientRect().top - readerTop - saved.offset
}

export function splitLiveProjectionItems(
  items: LiveTaskProjectionItem[],
  isStreaming: boolean,
): { stable: LiveTaskProjectionItem[]; active: LiveTaskProjectionItem[] } {
  const stableCount = liveTaskStableRoundPrefixLength(items, isStreaming)
  return {
    stable: items.slice(0, stableCount),
    active: items.slice(stableCount),
  }
}

export function prependUniqueLiveProjectionItems(
  older: readonly LiveTaskProjectionItem[],
  current: readonly LiveTaskProjectionItem[],
): LiveTaskProjectionItem[] {
  const currentIds = new Set(current.map(item => item.id))
  return [...older.filter(item => !currentIds.has(item.id)), ...current]
}

export function appendUniqueLiveProjectionItems(
  current: readonly LiveTaskProjectionItem[],
  newer: readonly LiveTaskProjectionItem[],
): LiveTaskProjectionItem[] {
  const currentIds = new Set(current.map(item => item.id))
  return [...current, ...newer.filter(item => !currentIds.has(item.id))]
}

export async function loadBoundedRecoverySnapshot(
  liveId: string,
  runtimeSessionId: string,
  since: string | undefined,
): Promise<LiveSnapshotDto> {
  let snapshot = await liveApi.snapshot(
    liveId,
    runtimeSessionId,
    since,
    { limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
  )
  if (!since) return snapshot

  const entries = [...snapshot.entries]
  let pages = 1
  while (snapshot.page?.hasLater && snapshot.page.after) {
    if (pages >= 1_000) throw new Error('Live snapshot recovery exceeded the bounded page safety limit')
    snapshot = await liveApi.snapshot(
      liveId,
      runtimeSessionId,
      snapshot.page.after,
      { limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
    )
    entries.push(...snapshot.entries)
    pages += 1
  }
  return { ...snapshot, entries }
}

