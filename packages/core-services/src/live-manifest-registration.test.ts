import test from 'node:test'
import assert from 'node:assert/strict'
import type { LiveAdapter, LiveRuntimeState } from '@agent-lens/core'
import { DefaultLiveService } from './index'

function liveStub(): LiveAdapter {
  const runtime: LiveRuntimeState = {
    runtimeSessionId: 'mock-1', status: 'ready', isStreaming: false, pendingMessageCount: 0,
  }
  return {
    manifest: {
      pluginId: 'mock-live', pluginVersion: '1.0.0', apiVersion: '1.0',
      pluginType: 'live', displayName: 'Mock Live',
      liveId: 'mock-live', productId: 'mock',
      capabilities: ['create', 'send', 'stream'],
    },
    capabilities: new Set(['create', 'send', 'stream']),
    inputCapabilities: {
      text: 'native', largeText: 'unsupported', image: 'unsupported',
      file: 'unsupported', multiline: 'native',
    },
    async availability() { return { available: true } },
    async list() { return [runtime] },
    async start() { return runtime },
    async state() { return runtime },
    async snapshot() { return { state: runtime, entries: [] } },
    async send() {},
    subscribe() { return () => {} },
    async terminate() {},
    async dispose() {},
  }
}

test('Live registration rejects incompatible plugin metadata before exposing capabilities', () => {
  for (const invalid of [
    { pluginType: 'source' },
    { apiVersion: '99.0' },
    { pluginId: '' },
    { pluginVersion: '' },
    { displayName: '' },
    { liveId: '' },
    { productId: '' },
  ]) {
    const adapter = liveStub()
    Object.assign(adapter.manifest, invalid)
    assert.throws(() => new DefaultLiveService().register(adapter), /live manifest invalid/)
  }
})

test('Live registration accepts valid common manifest and disposes registration', () => {
  const lives = new DefaultLiveService()
  const adapter = liveStub()
  const disposable = lives.register(adapter)
  assert.equal(lives.get('mock-live') !== null, true)
  disposable.dispose()
  assert.equal(lives.get('mock-live'), null)
})
