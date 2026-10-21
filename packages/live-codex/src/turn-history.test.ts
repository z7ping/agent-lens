import test from 'node:test'
import assert from 'node:assert/strict'
import type { LiveRuntimeState } from '@agent-lens/core'
import { snapshotCodexTurnHistory } from './turn-history.js'
import type { CodexRpc } from './transport.js'

const state: LiveRuntimeState = {
  runtimeSessionId: 'thread-1', nativeSessionId: 'thread-1',
  workspacePath: '/work', status: 'ready', isStreaming: false, pendingMessageCount: 0,
}

class FakeTurnsRpc {
  requests: { method: string, params: Record<string, unknown> }[] = []
  pages: Record<string, unknown>[] = []
  async request(method: string, params: Record<string, unknown>) {
    this.requests.push({ method, params })
    assert.equal(method, 'thread/turns/list')
    return this.pages.shift() ?? { data: [], nextCursor: null, backwardsCursor: null }
  }
}

function agent(id: string, text: string) {
  return { id, type: 'agentMessage', text }
}

test('Legacy Codex turn pages recover full native items and use an exclusive resume anchor', async () => {
  const rpc = new FakeTurnsRpc()
  rpc.pages.push(
    {
      data: [
        { id: 'turn-2', items: [agent('assistant-2', 'older reply')] },
        { id: 'turn-1', items: [agent('assistant-1', 'oldest reply')] },
      ],
      nextCursor: 'older-turns', backwardsCursor: 'reverse-turn-2',
    },
    {
      data: [
        { id: 'turn-2', items: [agent('assistant-2', 'older reply'), agent('assistant-3', 'new reply')] },
      ],
      nextCursor: null, backwardsCursor: 'reverse-turn-2',
    },
    {
      data: [{ id: 'turn-2', items: [agent('assistant-2', 'older reply'), agent('assistant-3', 'new reply')] }],
      nextCursor: null, backwardsCursor: 'updated-reverse',
    },
  )
  const first = await snapshotCodexTurnHistory(rpc as unknown as CodexRpc, state, undefined, { limit: 10 })
  assert.deepEqual(first.entries.map(x => (x as { text: string }).text), ['oldest reply', 'older reply'])
  assert.ok(first.leafId?.startsWith('codex-turn-history:'))
  assert.equal(first.page?.hasEarlier, true)
  assert.ok(first.page?.before?.startsWith('codex-turn-history:'))
  const update = await snapshotCodexTurnHistory(rpc as unknown as CodexRpc, state, first.leafId ?? undefined, { limit: 10 })
  assert.deepEqual(update.entries.map(x => (x as { text: string }).text), ['new reply'])
  assert.ok(update.leafId && update.leafId !== first.leafId)
  assert.equal(rpc.requests[1]?.params.cursor, 'reverse-turn-2')
  assert.equal(rpc.requests[1]?.params.itemsView, 'full')
})

test('Legacy Codex pages retain within-turn position for tool-heavy histories', async () => {
  const rpc = new FakeTurnsRpc()
  const native = {
    data: [{ id: 'turn-1', items: [
      agent('a1', 'one'), agent('a2', 'two'),
      agent('a3', 'three'), agent('a4', 'four'),
      agent('a5', 'five'), agent('a6', 'six'),
    ] }],
    nextCursor: null, backwardsCursor: 'reverse-turn-1',
  }
  rpc.pages.push(native, native, native)
  const first = await snapshotCodexTurnHistory(rpc as unknown as CodexRpc, state, undefined, { limit: 4 })
  assert.deepEqual(first.entries.map(x => (x as { text: string }).text), ['five', 'six'])
  assert.equal(first.page?.hasEarlier, true)
  const second = await snapshotCodexTurnHistory(rpc as unknown as CodexRpc, state, undefined, { before: first.page!.before, limit: 4 })
  assert.deepEqual(second.entries.map(x => (x as { text: string }).text), ['three', 'four'])
  const third = await snapshotCodexTurnHistory(rpc as unknown as CodexRpc, state, undefined, { before: second.page!.before, limit: 4 })
  assert.deepEqual(third.entries.map(x => (x as { text: string }).text), ['one', 'two'])
  assert.equal(third.page?.hasEarlier, false)
  assert.equal(rpc.requests[1]?.params.sortDirection, 'desc')
})
