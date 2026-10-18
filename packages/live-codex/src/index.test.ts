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
    params: { threadId: 'thread-1', input: [{ type: 'text', text: 'Implement feature' }] },
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
  assert.equal(rpc.calls.at(-1)?.method, 'turn/interrupt')
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
