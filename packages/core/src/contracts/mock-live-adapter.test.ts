import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LIVE_SNAPSHOT_DEFAULT_LIMIT,
  LIVE_SNAPSHOT_MAX_LIMIT,
  type LiveAdapter,
  type LiveRuntimeEvent,
  type LiveRuntimeState,
} from './live'

/** Contract fixture: a new Agent can produce neutral events without a private Web renderer. */
function createMockLiveAdapter(): LiveAdapter {
  const runtime: LiveRuntimeState = {
    runtimeSessionId: 'mock-runtime-1', status: 'ready', isStreaming: false, pendingMessageCount: 0,
  }
  const entries: unknown[] = []
  const listeners = new Set<(event: LiveRuntimeEvent) => void>()
  let sequence = 0
  return {
    manifest: {
      pluginId: 'agent-lens-test-mock-live',
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'live',
      displayName: 'Mock Live',
      liveId: 'mock-live',
      productId: 'mock',
      capabilities: ['create', 'send', 'stream'],
    },
    capabilities: new Set(['create', 'send', 'stream']),
    inputCapabilities: {
      text: 'native', largeText: 'unsupported', image: 'unsupported',
      file: 'unsupported', multiline: 'native',
    },
    startCapabilities: { workspace: 'unsupported', title: 'optional' },
    async availability() { return { available: true } },
    async list() { return [runtime] },
    async start() { return runtime },
    async state(id) {
      if (id !== runtime.runtimeSessionId) throw new Error('unknown runtime')
      return runtime
    },
    async snapshot(id, _since, window) {
      if (id !== runtime.runtimeSessionId) throw new Error('unknown runtime')
      const requested = window?.limit ?? LIVE_SNAPSHOT_DEFAULT_LIMIT
      const limit = Math.max(0, Math.min(LIVE_SNAPSHOT_MAX_LIMIT, requested))
      return { state: runtime, entries: entries.slice(-limit) }
    },
    async send(id, message) {
      if (id !== runtime.runtimeSessionId) throw new Error('unknown runtime')
      const text = typeof message === 'string'
        ? message
        : message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n')
      entries.push({ type: 'message', role: 'user', content: text })
      const event: LiveRuntimeEvent = {
        runtimeSessionId: id, sequence: ++sequence, receivedAt: new Date(0).toISOString(),
        event: { kind: 'mock-answer' },
        normalizedEvent: { type: 'text.delta', messageId: 'mock-reply', delta: `echo: ${text}` },
      }
      for (const listener of listeners) listener(event)
    },
    subscribe(_id, listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async terminate() {},
    async dispose() { listeners.clear() },
  }
}

test('third-party mock Live adapter produces standard events without Agent-specific UI', async () => {
  const adapter = createMockLiveAdapter()
  assert.equal((await adapter.availability()).available, true)
  const runtime = await adapter.start({})
  const events: LiveRuntimeEvent[] = []
  const unsubscribe = adapter.subscribe(runtime.runtimeSessionId, event => events.push(event))
  await adapter.send(runtime.runtimeSessionId, 'hello')
  assert.equal(events.length, 1)
  assert.deepEqual(events[0]?.normalizedEvent, {
    type: 'text.delta', messageId: 'mock-reply', delta: 'echo: hello',
  })
  assert.equal((await adapter.snapshot(runtime.runtimeSessionId)).entries.length, 1)
  unsubscribe()
  await adapter.send(runtime.runtimeSessionId, 'again')
  assert.equal(events.length, 1)
  await adapter.dispose()
})
