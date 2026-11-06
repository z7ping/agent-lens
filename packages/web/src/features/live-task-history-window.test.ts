import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { LiveSnapshotDto } from '@agent-lens/protocol'
import type { LiveTaskProjectionItem } from './live-task-projection'
import {
  LIVE_TASK_SNAPSHOT_PAGE_LIMIT,
  loadBoundedRecoverySnapshot,
  aggregateHistoryPage,
  captureLiveReaderAnchor,
  restoreLiveReaderAnchor,
  compactHistoryBlocks,
  refreshLatestHistoryBlock,
  type LiveHistoryPageBlock,
} from './live-task-history-window'

const block = (id: string, hasEarlier = true): LiveHistoryPageBlock => ({
  page: { hasEarlier },
  itemIds: [id],
})

test('Live 有界窗口每页上限保持 120，旧方向分页保留前 5 块', () => {
  assert.equal(LIVE_TASK_SNAPSHOT_PAGE_LIMIT, 120)
  const input = Array.from({ length: 6 }, (_, i) => block(String(i)))
  const result = compactHistoryBlocks(input, 'older')
  assert.deepEqual(result.blocks.map(value => value.itemIds[0]), ['0', '1', '2', '3', '4'])
  assert.deepEqual([...result.removedIds], ['5'])
  assert.equal(input.length, 6, '窗口裁剪不得修改外部传入的页块数组')
})

test('向最新方向分页移除最早页，交叠 ID 仍属于当前可见窗口', () => {
  const input = Array.from({ length: 6 }, (_, i) => block(String(i)))
  input[0]!.itemIds.push('shared')
  input[2]!.itemIds.push('shared')
  const result = compactHistoryBlocks(input, 'newer')
  assert.deepEqual(result.blocks.map(value => value.itemIds[0]), ['1', '2', '3', '4', '5'])
  assert.deepEqual([...result.removedIds], ['0'])
  assert.equal(result.removedIds.has('shared'), false, '不能移除其他页仍在使用的投影项')
})

test('历史窗口首尾页信息聚合，保持最早游标与最新轮次区间', () => {
  const pages: LiveHistoryPageBlock[] = [
    { page: { hasEarlier: true, before: 'cursor-a', rounds: { total: 12, firstOrdinal: 1 } }, itemIds: ['a'] },
    { page: { hasEarlier: false, hasLater: true, after: 'cursor-b', rounds: { total: 12, lastOrdinal: 12 } }, itemIds: ['b'] },
  ]
  const result = aggregateHistoryPage(pages)
  assert.equal(result.hasEarlier, true)
  assert.equal(result.before, 'cursor-a')
  assert.equal(result.hasLater, true)
  assert.equal(result.after, 'cursor-b')
  assert.deepEqual(result.rounds, { total: 12, firstOrdinal: 1, lastOrdinal: 12 })
  assert.deepEqual(aggregateHistoryPage([]), { hasEarlier: false })
})

test('活动投影刷新末页时不重复插入已存在的稳定历史项', () => {
  const fixed = block('already-fixed')
  const tail = block('old-active')
  const entry = (id: string) => ({ id } as LiveTaskProjectionItem)
  const next = refreshLatestHistoryBlock([fixed, tail], {
    stable: [entry('already-fixed'), entry('new-stable')],
    active: [entry('new-active')],
  })
  assert.deepEqual(next[0]!.itemIds, ['already-fixed'])
  assert.deepEqual(next[1]!.itemIds, ['new-stable', 'new-active'])
  assert.deepEqual(tail.itemIds, ['old-active'], '刷新不能原地修改旧的历史窗口')
})

test('recovery restores a detached reader by semantic round rather than jumping to the end', () => {
  let roundTop = 150
  const reader = {
    clientHeight: 600,
    scrollTop: 250,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => [round],
  } as unknown as HTMLElement
  const round = {
    dataset: { interactionId: 'live-round:user-a' },
    getBoundingClientRect: () => ({ top: roundTop }),
    closest: () => reader,
  }
  const anchor = captureLiveReaderAnchor(reader)
  assert.equal(anchor.interactionId, 'live-round:user-a')
  roundTop = 180
  restoreLiveReaderAnchor(reader, anchor)
  assert.equal(reader.scrollTop, 280, 'same round must remain at its prior screen offset')
})

test('background tab never unmounts virtualized content or resets Live input and projection', () => {
  const virtual = readFileSync(new URL('../components/VirtualRoundMount.tsx', import.meta.url), 'utf8')
  const runtime = readFileSync(new URL('./use-live-task-runtime.ts', import.meta.url), 'utf8')
  const page = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')
  assert.match(virtual, /document\.visibilityState === 'hidden'\) return/)
  assert.match(runtime, /restoreLiveReaderAnchor\(reader, saved\.anchor\)/)
  assert.match(runtime, /reconcileLiveSnapshotProjection\(previous, nextProjection/)
  assert.match(runtime, /shouldRecoverLiveOnVisible\(hiddenForMs, streamDisconnected\)/)
  assert.match(page, /readLiveComposerDraft\(composerDraftKey\)/)
  assert.match(page, /processExpansionStore=\{processExpansionStore\}/)
})


test('Pi paged recovery retains earliest and latest native cursors and exact journal entries', async () => {
  const state = {} as LiveSnapshotDto['state']
  const snapshots = new Map<string, LiveSnapshotDto>([
    ['old-leaf', { state, entries: [{ type: 'compaction', id: 'compaction-a' }],
      leafId: 'new-leaf', page: { hasEarlier: true, before: 'record-a',
        first: 'record-a', last: 'record-b', hasLater: true, after: 'record-b',
        rounds: { total: 9, firstOrdinal: 4, lastOrdinal: 5 } } }],
    ['record-b', { state, entries: [{ type: 'compaction', id: 'compaction-c' }],
      leafId: 'new-leaf', page: { hasEarlier: true, before: 'record-c',
        first: 'record-c', last: 'record-d', hasLater: true, after: 'record-d',
        rounds: { total: 9, firstOrdinal: 6, lastOrdinal: 7 } } }],
    ['record-d', { state, entries: [{ type: 'compaction', id: 'compaction-e' }],
      leafId: 'new-leaf', page: { hasEarlier: true, before: 'record-e',
        first: 'record-e', last: 'record-f', hasLater: false,
        rounds: { total: 9, firstOrdinal: 8, lastOrdinal: 9 } } }],
  ])
  const requests: Array<{ cursor: string | undefined; limit: number | undefined }> = []
  const fetch = async (_live: string, _runtime: string, cursor?: string, window?: { limit?: number }): Promise<LiveSnapshotDto> => {
    requests.push({ cursor, limit: window?.limit })
    const snapshot = snapshots.get(cursor ?? '')
    if (!snapshot) throw new Error('Unexpected page cursor')
    return snapshot
  }
  const result = await loadBoundedRecoverySnapshot('pi', 'runtime', 'old-leaf', fetch)
  assert.deepEqual(result.entries.map(entry => (entry as { id: string }).id),
    ['compaction-a', 'compaction-c', 'compaction-e'])
  assert.deepEqual(requests, [
    { cursor: 'old-leaf', limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
    { cursor: 'record-b', limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
    { cursor: 'record-d', limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT },
  ])
  assert.equal(result.page?.before, 'record-a')
  assert.equal(result.page?.first, 'record-a')
  assert.equal(result.page?.last, 'record-f')
  assert.equal(result.page?.hasEarlier, true)
  assert.equal(result.page?.hasLater, undefined)
  assert.deepEqual(result.page?.rounds, { total: 9, firstOrdinal: 4, lastOrdinal: 9 })
  assert.equal(result.leafId, 'new-leaf')
})

test('Pi paged recovery fails closed on incomplete or repeated next-page cursors', async () => {
  const state = {} as LiveSnapshotDto['state']
  const invalid: LiveSnapshotDto = {
    state, entries: [{ id: 'first' }], page: { hasEarlier: true, hasLater: true },
  }
  await assert.rejects(loadBoundedRecoverySnapshot('pi', 'runtime', 'old-leaf',
    async () => invalid), /missing or repeated native page cursor/)

  let calls = 0
  await assert.rejects(loadBoundedRecoverySnapshot('pi', 'runtime', 'old-leaf',
    async () => {
      calls++
      return { state, entries: [{ id: `first-${calls}` }],
        page: { hasEarlier: true, hasLater: true, after: 'stalled-cursor' } }
    }), /missing or repeated native page cursor/)
  assert.equal(calls, 2, 'must stop immediately without issuing 1000 redundant page requests')
})
