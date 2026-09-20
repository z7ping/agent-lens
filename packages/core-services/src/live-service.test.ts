import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  LiveAdapter,
  LiveCapabilityName,
  LiveRuntimeEvent,
  LiveRuntimeState,
} from '@agent-lens/core'
import { DefaultLiveService } from './index'

const readyState: LiveRuntimeState = {
  runtimeSessionId: 'runtime-1',
  status: 'ready',
  isStreaming: false,
  pendingMessageCount: 0,
}

function liveAdapter(
  liveId: string,
  capabilities: readonly LiveCapabilityName[],
  withThinkingMethods: boolean,
): LiveAdapter {
  const base: LiveAdapter = {
    manifest: {
      pluginId: `test-${liveId}`,
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'live',
      displayName: liveId,
      liveId,
      productId: 'pi',
      capabilities: [...capabilities],
    },
    capabilities: new Set(capabilities),
    inputCapabilities: {
      text: 'native',
      largeText: 'transform',
      image: 'unsupported',
      file: 'unsupported',
      multiline: 'native',
    },
    availability: async () => ({ available: true }),
    list: async () => [readyState],
    start: async () => readyState,
    state: async () => readyState,
    snapshot: async () => ({ state: readyState, entries: [] }),
    send: async () => {},
    subscribe: () => () => {},
    terminate: async () => {},
    dispose: async () => {},
  }
  if (!withThinkingMethods) return base

  return {
    ...base,
    thinkingControl: async () => ({
      capability: 'thinking-control',
      value: 'off',
      options: [{ value: 'off' }],
    }),
    setThinkingControl: async () => readyState,
  }
}

test('Live registry rejects adapters that advertise thinking-control without implementing the control boundary', () => {
  const service = new DefaultLiveService()
  assert.throws(
    () => service.register(liveAdapter('missing-methods', ['thinking-control'], false)),
    /thinking-control capability\/method mismatch/,
  )
})

test('Live registry rejects hidden thinking-control methods when capability is not declared', () => {
  const service = new DefaultLiveService()
  assert.throws(
    () => service.register(liveAdapter('hidden-capability', [], true)),
    /thinking-control capability\/method mismatch/,
  )
})

test('Live registry accepts thinking-control only when capability and methods agree', () => {
  const service = new DefaultLiveService()
  const adapter = liveAdapter('valid-thinking', ['thinking-control'], true)
  service.register(adapter)
  assert.equal(service.get('valid-thinking'), adapter)
})


test('Live observers see first send and completed checkpoints without changing adapter identity', async () => {
  const service = new DefaultLiveService()
  const state: LiveRuntimeState = {
    runtimeSessionId: 'runtime-observed',
    logicalSessionId: 'session-observed',
    workspacePath: '/workspace/project',
    status: 'ready',
    isStreaming: false,
    pendingMessageCount: 0,
  }
  let listener: ((event: LiveRuntimeEvent) => void) | undefined
  let sends = 0
  const adapter = liveAdapter('observed', ['stream'], false)
  adapter.state = async () => state
  adapter.send = async () => { sends += 1 }
  adapter.subscribe = (_runtimeSessionId, next) => {
    listener = next
    return () => { listener = undefined }
  }

  const seen: string[] = []
  service.observe({
    beforeSend: context => {
      seen.push(`before:${context.runtime.runtimeSessionId}`)
    },
    settled: context => {
      seen.push(`settled:${context.reason}`)
    },
  })
  service.register(adapter)

  assert.equal(service.get('observed'), adapter)
  await adapter.send('runtime-observed', 'hello')
  assert.equal(sends, 1)
  assert.deepEqual(seen, ['before:runtime-observed'])
  assert.ok(listener)

  listener!({
    runtimeSessionId: 'runtime-observed',
    sequence: 1,
    receivedAt: '2026-09-20T00:00:00.000Z',
    event: {},
    normalizedEvent: { type: 'completed', status: 'completed' },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(seen, ['before:runtime-observed', 'settled:completed'])
})

test('Live observer failures never break the underlying send', async () => {
  const service = new DefaultLiveService()
  let sends = 0
  const adapter = liveAdapter('observer-failure', [], false)
  adapter.send = async () => { sends += 1 }
  service.observe({
    beforeSend: async () => {
      throw new Error('observer failed')
    },
  })
  service.register(adapter)

  await adapter.send('runtime-1', 'hello')
  assert.equal(sends, 1)
})

test('terminal Live settlement is emitted once even when runtime also reports terminated', async () => {
  const service = new DefaultLiveService()
  const state: LiveRuntimeState = {
    runtimeSessionId: 'runtime-terminal',
    status: 'ready',
    isStreaming: false,
    pendingMessageCount: 0,
  }
  let listener: ((event: LiveRuntimeEvent) => void) | undefined
  const adapter = liveAdapter('terminal', ['stream'], false)
  adapter.state = async () => state
  adapter.subscribe = (_runtimeSessionId, next) => {
    listener = next
    return () => { listener = undefined }
  }

  const reasons: string[] = []
  service.observe({
    settled: context => { reasons.push(context.reason) },
  })
  service.register(adapter)
  await adapter.send('runtime-terminal', 'hello')

  listener!({
    runtimeSessionId: 'runtime-terminal',
    sequence: 1,
    receivedAt: '2026-09-20T00:00:00.000Z',
    event: {},
    normalizedEvent: { type: 'status', status: 'terminated' },
  })
  listener!({
    runtimeSessionId: 'runtime-terminal',
    sequence: 2,
    receivedAt: '2026-09-20T00:00:01.000Z',
    event: {},
    normalizedEvent: { type: 'status', status: 'terminated' },
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(reasons, ['terminated'])
})
