import assert from 'node:assert/strict'
import test from 'node:test'
import type { Plugin } from '@deepseek-ai/cordis'
import type { LiveAdapter, LiveRuntimeEvent, SourceDefinition, SourceRecord } from '@agent-lens/core'
import { createTestCapturePolicy } from '@agent-lens/core-services/test-support'
import {
  AgentLensApplication, coreServicesPlugin, defineAgentLensIntegration,
  defineAgentLensPlugin, prepareRegisteredSources, syncRegisteredSourceHistory,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'

const time = '2026-10-20T00:00:00.000Z'
const productId = 'third-party-product'
const sourceId = 'third-party-source'
const liveId = 'third-party-live'

/**
 * A third-party integration exercises the real Cordis registration and
 * Source Runner -> canonical SQLite path, not a separate mock renderer/runtime.
 */
test('third-party Source and Live share Cordis runtime and canonical history pipeline', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  const source: SourceDefinition = {
    manifest: {
      pluginId: 'test-third-party-source', pluginVersion: '1.0.0',
      apiVersion: '1.0', pluginType: 'source', displayName: 'Third-party Source',
      sourceId, productId, parserVersion: '1',
    },
    async detect() { return [{ sourceId, productId, confidence: 'exact' }] },
    async declareCapabilities() {
      return [{ sourceId, name: 'history', status: 'available', captureModes: ['native-log'] }]
    },
    async *ingestHistory(ctx) {
      const record: SourceRecord = {
        id: 'third-party-record',
        sourceId, installationId: ctx.installation.id,
        sourceSessionNativeId: 'native-session-1',
        nativeId: 'native-event-1', nativeType: 'custom.unknown',
        capturedAt: time, locator: { kind: 'file', path: '/mock/custom.log' },
        payload: { content: 'original native evidence' }, parserVersion: '1',
      }
      yield record
    },
    async normalize(record) {
      return {
        observations: [{
          kind: 'unknown' as const,
          capturedAt: record.capturedAt,
          nativeEventId: record.nativeId,
          identityHints: { nativeSessionId: record.sourceSessionNativeId ?? 'unknown' },
          payload: { rawType: record.nativeType, rawPayload: record.payload },
        }],
        evidenceCandidates: [{
          captureMethod: 'native-log' as const, derivation: 'observed' as const,
          confidenceHint: 'exact' as const, sourceRecordId: record.id,
          sourceLocator: record.locator, capturedAt: record.capturedAt,
        }],
      }
    },
  }

  const listeners = new Set<(event: LiveRuntimeEvent) => void>()
  const runtime = {
    runtimeSessionId: 'third-party-session', status: 'ready' as const,
    isStreaming: false, pendingMessageCount: 0,
  }
  const live: LiveAdapter = {
    manifest: {
      pluginId: 'test-third-party-live', pluginVersion: '1.0.0',
      apiVersion: '1.0', pluginType: 'live', displayName: 'Third-party Live',
      productId, liveId, capabilities: ['create', 'send', 'stream'],
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
    async state() { return runtime },
    async snapshot() { return { state: runtime, entries: [] } },
    async send(id, message) {
      const text = typeof message === 'string' ? message
        : message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n')
      for (const listener of listeners) listener({
        runtimeSessionId: id, sequence: 1, receivedAt: time,
        event: { kind: 'custom.output', native: true },
        normalizedEvent: { type: 'text.delta', delta: 'echo: ' + text },
      })
    },
    subscribe(_id, listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async terminate() {},
    async dispose() { listeners.clear() },
  }

  const sourceComponent: Plugin.Function<void> = (ctx: AgentLensContext) => {
    const handle = ctx.sources.register(source)
    return () => handle.dispose()
  }
  sourceComponent.inject = ['sources']
  const liveComponent: Plugin.Function<void> = (ctx: AgentLensContext) => {
    const handle = ctx.lives.register(live)
    return () => handle.dispose()
  }
  liveComponent.inject = ['lives']

  const app = new AgentLensApplication()
  const provideStorage: Plugin.Function<void> = (ctx: AgentLensContext) => ctx.provide('storage', storage)
  app.useRuntime(provideStorage)
  app.useRuntime(coreServicesPlugin)
  app.useIntegration(defineAgentLensIntegration({
    integrationId: 'third-party-integration', productId, displayName: 'Third-party',
    apiVersion: '1.0', capabilities: ['source', 'live'],
    componentPluginIds: [source.manifest.pluginId, live.manifest.pluginId],
  }, [
    {
      pluginId: source.manifest.pluginId, capabilities: ['source'],
      activation: 'catalog', lifecycle: 'plugin',
      plugin: defineAgentLensPlugin(source.manifest, sourceComponent),
    },
    {
      pluginId: live.manifest.pluginId, capabilities: ['live'],
      activation: 'enabled', lifecycle: 'plugin',
      plugin: defineAgentLensPlugin(live.manifest, liveComponent),
    },
  ]))

  try {
    await app.start()
    const ctx = app.context as AgentLensContext
    const unprovidePolicy = ctx.provide('capturePolicy', createTestCapturePolicy([sourceId]))
    try {
      assert.equal(ctx.sources.list().length, 1)
      assert.equal(ctx.lives.get(liveId), live)
      const prepared = await prepareRegisteredSources(ctx, new AbortController().signal)
      assert.equal(prepared.failures.length, 0)
      assert.equal(prepared.targets.length, 1)
      const synced = await syncRegisteredSourceHistory(ctx, new AbortController().signal, prepared.targets)
      assert.equal(synced.failures.length, 0)
      assert.equal(synced.results[0]?.records, 1)
      assert.equal(synced.results[0]?.observationsCreated, 1)
      const events: LiveRuntimeEvent[] = []
      const unsubscribe = live.subscribe(runtime.runtimeSessionId, event => events.push(event))
      await live.send(runtime.runtimeSessionId, 'hello')
      assert.deepEqual(events.map(event => event.normalizedEvent), [
        { type: 'text.delta', delta: 'echo: hello' },
      ])
      assert.deepEqual(events[0]?.event, { kind: 'custom.output', native: true })
      unsubscribe()
      assert.equal((await app.resolveIntegrationStatus(productId))?.availability, 'available')
    } finally {
      unprovidePolicy()
    }
  } finally {
    if (app.state === 'running') await app.stop()
    await storage.close()
  }
})
