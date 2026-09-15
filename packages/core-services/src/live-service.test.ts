import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  LiveAdapter,
  LiveCapabilityName,
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
