import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCodexEvent, codexSnapshotEntries } from './events.js'
import { CodexLiveAdapter } from './index.js'
import type { CodexRpc, RpcMessage } from './transport.js'

test('Codex streams assistant, reasoning, tools and terminal status to shared events', () => {
  assert.deepEqual(normalizeCodexEvent('item/agentMessage/delta',
    { itemId: 'm1', delta: 'hello' }),
  { type: 'text.delta', delta: 'hello', messageId: 'm1' })
  assert.deepEqual(normalizeCodexEvent('item/reasoning/summaryTextDelta',
    { itemId: 'r1', delta: 'thinking' }),
  { type: 'reasoning.delta', delta: 'thinking', messageId: 'r1' })
  assert.deepEqual(normalizeCodexEvent('item/started',
    { item: { id: 'tool1', type: 'commandExecution', command: 'pwd' } }),
  { type: 'tool.start', callId: 'tool1', name: 'shell', inputPreview: 'pwd' })
  assert.deepEqual(normalizeCodexEvent('turn/completed',
    { turn: { status: 'interrupted' } }),
  { type: 'completed', status: 'interrupted' })
})

test('Codex history conversion is bounded and preserves native entry identity', () => {
  const result = codexSnapshotEntries([{ items: [
    { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
    { id: 'a1', type: 'agentMessage', text: 'world' },
  ] }], 1)
  assert.equal(result.entries.length, 1)
  assert.equal(result.hasEarlier, true)
  assert.deepEqual(result.entries[0], { type: 'message', id: 'a1', role: 'assistant', text: 'world' })
})

class FakeRpc {
  listener: ((message: RpcMessage) => void) | undefined = undefined
  calls: { method: string, params: Record<string, unknown> }[] = []
  responses: { id: number | string, value: Record<string, unknown> }[] = []
  itemPages: Record<string, unknown>[] = []
  async available() { return true }
  subscribe(listener: (message: RpcMessage) => void) {
    this.listener = listener
    return () => { this.listener = undefined }
  }
  async request(method: string, params: Record<string, unknown>) {
    this.calls.push({ method, params })
    if (method === 'thread/start') return { thread: { id: 'thread-1' } }
    if (method === 'turn/start') return { turn: { id: 'turn-1' } }
    if (method === 'thread/read') return { thread: { turns: [] } }
    if (method === 'thread/items/list') return this.itemPages.shift() ?? { data: [], nextCursor: null, backwardsCursor: null }
    if (method === 'model/list') return { data: [
      { id: 'codex-one', model: 'codex-one', displayName: 'Codex One', hidden: false,
        defaultReasoningEffort: 'medium', supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast' },
          { reasoningEffort: 'medium', description: 'Balanced' },
        ] },
    ] }
    return {}
  }
  respond(id: number | string, value: Record<string, unknown>) {
    this.responses.push({ id, value })
  }
  reject(id: number | string) { this.responses.push({ id, value: { rejected: true } }) }
  dispose() {}
  emit(message: RpcMessage) { this.listener?.(message) }
}

test('Codex integration uses native thread and turn ids, explicit approval, and interrupt', async () => {
  const rpc = new FakeRpc()
  const adapter = new CodexLiveAdapter(rpc as unknown as CodexRpc)
  const session = await adapter.start({ workspacePath: '/project' })
  assert.equal(session.nativeSessionId, 'thread-1')
  const events: string[] = []
  const off = adapter.subscribe(session.runtimeSessionId, e => {
    if (e.normalizedEvent) events.push(e.normalizedEvent.type)
  })
  await adapter.send(session.runtimeSessionId, 'Implement feature')
  assert.deepEqual(rpc.calls.at(-1), {
    method: 'turn/start',
    params: { threadId: 'thread-1', input: [{ type: 'text', text: 'Implement feature', text_elements: [] }] },
  })
  rpc.emit({
    method: 'item/commandExecution/requestApproval', id: 5,
    params: { threadId: 'thread-1', command: 'npm test' },
  })
  assert.equal(rpc.responses.length, 0, 'approval must not be automatic')
  assert.ok(events.includes('ui.request'))
  await adapter.respondToExtension(session.runtimeSessionId, '5', { confirmed: false })
  assert.deepEqual(rpc.responses, [{ id: 5, value: { decision: 'decline' } }])
  await adapter.interrupt(session.runtimeSessionId)
  assert.deepEqual(rpc.calls.at(-1), {
    method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' },
  })
  rpc.emit({ method: 'turn/completed', params: {
    threadId: 'thread-1', turn: { status: 'interrupted' },
  } })
  assert.equal((await adapter.state(session.runtimeSessionId)).isStreaming, false)
  off()
  await adapter.dispose()
})

test('Unknown approval methods fail closed', async () => {
  const rpc = new FakeRpc()
  const adapter = new CodexLiveAdapter(rpc as unknown as CodexRpc)
  await adapter.start({ workspacePath: '/project' })
  rpc.emit({ method: 'item/permissions/requestApproval', id: 8,
    params: { threadId: 'thread-1' } })
  assert.deepEqual(rpc.responses, [{ id: 8, value: { rejected: true } }])
  await adapter.dispose()
})

test('Models and reasoning levels are discovered from Codex instead of hard-coded', async () => {
  const rpc = new FakeRpc()
  const adapter = new CodexLiveAdapter(rpc as unknown as CodexRpc)
  const session = await adapter.start({ workspacePath: '/project' })
  const models = await adapter.modelControl(session.runtimeSessionId)
  assert.deepEqual(models?.options.map(option => option.value), ['codex-one'])
  await adapter.setModelControl(session.runtimeSessionId, 'codex-one')
  const thinking = await adapter.thinkingControl(session.runtimeSessionId)
  assert.deepEqual(thinking?.options.map(option => option.value), ['low', 'medium'])
  await adapter.setThinkingControl(session.runtimeSessionId, 'low')
  await adapter.send(session.runtimeSessionId, 'Hi')
  assert.equal(rpc.calls.at(-1)?.params.model, 'codex-one')
  assert.equal(rpc.calls.at(-1)?.params.effort, 'low')
  await adapter.dispose()
})

test('Snapshot emits a finished file-change tool even when Codex has no output', () => {
  const result = codexSnapshotEntries([{ items: [
    { id: 'patch-1', type: 'fileChange', changes: [{ path: 'a.ts' }], status: 'completed' },
  ] }], 10)
  assert.equal(result.entries.length, 2)
  const terminal = result.entries[1] as Record<string, unknown>
  assert.equal(terminal.role, 'toolResult')
  assert.equal(terminal.toolCallId, 'patch-1')
  assert.equal(terminal.isError, false)
})

test('Missing active Codex turn id does not send malformed interrupt requests', async () => {
  const rpc = new FakeRpc()
  const adapter = new CodexLiveAdapter(rpc as unknown as CodexRpc)
  const session = await adapter.start({ workspacePath: '/project' })
  rpc.emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: {} } })
  await assert.rejects(() => adapter.interrupt(session.runtimeSessionId), /turn ID is unavailable/)
  assert.equal(rpc.calls.some(call => call.method === 'turn/interrupt'), false)
  await adapter.dispose()
})

test('Codex command output deltas are accumulated per item and reset on completion', async () => {
  const rpc = new FakeRpc()
  const adapter = new CodexLiveAdapter(rpc as unknown as CodexRpc)
  const session = await adapter.start({ workspacePath: '/project' })
  const outputs: string[] = []
  const completed: string[] = []
  const unsubscribe = adapter.subscribe(session.runtimeSessionId, event => {
    if (event.normalizedEvent?.type === 'tool.output') outputs.push(event.normalizedEvent.output)
    if (event.normalizedEvent?.type === 'tool.end') completed.push(event.normalizedEvent.output ?? '')
  })
  rpc.emit({ method: 'item/commandExecution/outputDelta',
    params: { threadId: 'thread-1', itemId: 'cmd-1', delta: 'hello' } })
  rpc.emit({ method: 'item/commandExecution/outputDelta',
    params: { threadId: 'thread-1', itemId: 'cmd-1', delta: ' world' } })
  assert.deepEqual(outputs, ['hello', 'hello world'])
  rpc.emit({ method: 'item/completed',
    params: { threadId: 'thread-1', item: { id: 'cmd-1', type: 'commandExecution', status: 'completed' } } })
  assert.equal(completed.at(-1), 'hello world')
  rpc.emit({ method: 'item/commandExecution/outputDelta',
    params: { threadId: 'thread-1', itemId: 'cmd-1', delta: 'later' } })
  assert.equal(outputs.at(-1), 'later')
  unsubscribe()
  await adapter.dispose()
})

test('Concurrent native approvals are shown one at a time without auto-confirmation', async () => {
  const rpc = new FakeRpc()
  const adapter = new CodexLiveAdapter(rpc as unknown as CodexRpc)
  const session = await adapter.start({ workspacePath: '/project' })
  const requests: string[] = []
  const unsubscribe = adapter.subscribe(session.runtimeSessionId, event => {
    if (event.normalizedEvent?.type === 'ui.request') requests.push(event.normalizedEvent.requestId)
  })
  rpc.emit({ id: 40, method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-1', command: 'git status' } })
  rpc.emit({ id: 41, method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread-1', reason: 'edit code' } })
  assert.deepEqual(requests, ['40'])
  assert.equal(rpc.responses.length, 0)
  await assert.rejects(() => adapter.respondToExtension(session.runtimeSessionId, '41', { confirmed: true }), /not active/)
  await adapter.respondToExtension(session.runtimeSessionId, '40', { confirmed: false })
  assert.deepEqual(requests, ['40', '41'])
  await adapter.respondToExtension(session.runtimeSessionId, '41', { confirmed: false })
  assert.deepEqual(rpc.responses.map(x => x.value.decision), ['decline', 'decline'])
  unsubscribe()
  await adapter.dispose()
})

test('Stale turn completion cannot terminate a newer Codex turn', async () => {
  const rpc = new FakeRpc()
  const adapter = new CodexLiveAdapter(rpc as unknown as CodexRpc)
  const session = await adapter.start({ workspacePath: '/project' })
  await adapter.send(session.runtimeSessionId, 'run')
  rpc.emit({ method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'old-turn', status: 'completed' } } })
  assert.equal((await adapter.state(session.runtimeSessionId)).isStreaming, true)
  rpc.emit({ method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
  assert.equal((await adapter.state(session.runtimeSessionId)).isStreaming, false)
  await adapter.dispose()
})

test('Codex recovery uses a cross-turn native cursor and excludes the repeated anchor', async () => {
  const rpc = new FakeRpc()
  rpc.itemPages.push(
    {
      data: [
        { turnId: 'turn-2', item: { type: 'agentMessage', id: 'assistant-2', text: 'previous' } },
        { turnId: 'turn-1', item: { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'old' }] } },
      ],
      nextCursor: 'older', backwardsCursor: 'native-reverse-anchor',
    },
    {
      data: [
        { turnId: 'turn-2', item: { type: 'agentMessage', id: 'assistant-2', text: 'previous' } },
        { turnId: 'turn-3', item: { type: 'userMessage', id: 'user-3', content: [{ type: 'text', text: 'new' }] } },
      ],
      nextCursor: null, backwardsCursor: 'other-way',
    },
    {
      data: [{ turnId: 'turn-3', item: { type: 'userMessage', id: 'user-3', content: [{ type: 'text', text: 'new' }] } }],
      nextCursor: 'older', backwardsCursor: 'new-reverse-anchor',
    },
  )
  const adapter = new CodexLiveAdapter(rpc as unknown as CodexRpc)
  const session = await adapter.start({ workspacePath: '/project' })
  const first = await adapter.snapshot(session.runtimeSessionId)
  assert.ok(first.leafId?.startsWith('codex-item:'))
  const newer = await adapter.snapshot(session.runtimeSessionId, first.leafId ?? undefined)
  assert.equal(newer.entries.length, 1)
  assert.ok(newer.leafId && newer.leafId !== first.leafId)
  const calls = rpc.calls.filter(call => call.method === 'thread/items/list')
  assert.equal(calls[1]?.params.sortDirection, 'asc')
  assert.equal(calls[1]?.params.cursor, 'native-reverse-anchor')
  assert.equal(Object.hasOwn(calls[1]!.params, 'turnId'), false, 'must not restrict continuation to the old turn')
  await adapter.dispose()
})
