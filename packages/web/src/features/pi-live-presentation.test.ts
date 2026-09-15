import assert from 'node:assert/strict'
import test from 'node:test'
import { appendPiLiveDelta, finishPiLiveContentBlock, startPiLiveContentBlock, startPiLiveTool, updatePiLiveTool } from './pi-live-current'
import type { PiLiveHistoryItem } from './pi-live-history'
import { PiLivePresentationScheduler } from './pi-live-presentation'

function applySequential(mutations: Array<(items: PiLiveHistoryItem[]) => PiLiveHistoryItem[]>): PiLiveHistoryItem[] {
  return mutations.reduce((items, mutation) => mutation(items), [] as PiLiveHistoryItem[])
}

test('presentation scheduler batches 10,000 ordered text/thinking deltas without loss or reordering', () => {
  const mutations: Array<(items: PiLiveHistoryItem[]) => PiLiveHistoryItem[]> = []
  mutations.push(items => startPiLiveContentBlock(items, 'text', { messageEpoch: 1, contentIndex: 0 }))
  mutations.push(items => startPiLiveContentBlock(items, 'thinking', { messageEpoch: 1, contentIndex: 1 }))
  for (let index = 0; index < 10_000; index += 1) {
    const kind = index % 5 === 0 ? 'thinking' as const : 'text' as const
    const contentIndex = kind === 'thinking' ? 1 : 0
    mutations.push(items => appendPiLiveDelta(items, kind, String(index % 10), { messageEpoch: 1, contentIndex }))
  }

  const expected = applySequential(mutations)
  let actual: PiLiveHistoryItem[] = []
  let commits = 0
  const scheduler = new PiLivePresentationScheduler<PiLiveHistoryItem[]>(mutation => {
    actual = mutation(actual)
    commits += 1
  }, 60_000)

  scheduler.boundary(mutations[0]!)
  scheduler.boundary(mutations[1]!)
  for (const mutation of mutations.slice(2)) scheduler.push(mutation)
  scheduler.flush()

  assert.deepEqual(actual, expected)
  assert.equal(commits, 3)
  assert.equal(scheduler.snapshot().queuedMutations, 10_000)
  assert.equal(scheduler.snapshot().maxQueueDepth, 10_000)
  scheduler.dispose()
})

test('presentation scheduler flushes buffered tool output before structural end boundary', () => {
  let items: PiLiveHistoryItem[] = []
  const scheduler = new PiLivePresentationScheduler<PiLiveHistoryItem[]>(mutation => {
    items = mutation(items)
  }, 60_000)

  scheduler.boundary(current => startPiLiveTool(current, {
    callId: 'tool-1',
    name: 'read',
    summary: '',
  }))
  scheduler.push(current => updatePiLiveTool(current, 'tool-1', 'a'))
  scheduler.push(current => updatePiLiveTool(current, 'tool-1', 'ab'))
  scheduler.boundary(current => finishPiLiveContentBlock(
    startPiLiveContentBlock(current, 'text', { messageEpoch: 1, contentIndex: 2 }, 'done'),
    'text',
    'done',
    { messageEpoch: 1, contentIndex: 2 },
  ))

  const tool = items.find(item => item.kind === 'tool')
  assert.equal(tool?.kind === 'tool' ? tool.output : '', 'ab')
  assert.equal(items.at(-1)?.kind, 'message')
  assert.equal(scheduler.snapshot().commitCount, 3)
  scheduler.dispose()
})
