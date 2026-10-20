import assert from 'node:assert/strict'
import test from 'node:test'
import type { Plugin } from '@deepseek-ai/cordis'
import type { LiveAdapter } from '@agent-lens/core'
import { DefaultLiveService } from '@agent-lens/core-services'
import type { AgentLensContext } from './context'
import { AgentLensApplication } from './application'
import { defineAgentLensIntegration } from './integration'
import { defineAgentLensPlugin } from './plugin'

test('AgentLensApplication starts and disposes Cordis plugins', async () => {
  const events: string[] = []
  const plugin: Plugin.Function<void> = () => {
    events.push('start')
    return () => {
      events.push('stop')
    }
  }

  const app = new AgentLensApplication()
  app.use(defineAgentLensPlugin({
    pluginId: '@agent-lens/test-lifecycle',
    pluginVersion: '1.0.0',
    apiVersion: '1.0',
    pluginType: 'surface',
    displayName: 'Lifecycle Test Plugin',
  }, plugin))

  await app.start()
  assert.equal(app.state, 'running')
  assert.deepEqual(events, ['start'])

  await app.stop()
  assert.equal(app.state, 'stopped')
  assert.deepEqual(events, ['start', 'stop'])
})


test('Agent Integration exposes assets as a first-class non-authorized capability', async () => {
  const component = defineAgentLensPlugin({
    pluginId: '@agent-lens/test-assets-component',
    pluginVersion: '1.0.0',
    apiVersion: '1.0',
    pluginType: 'source',
    displayName: 'Assets Test Component',
  }, (() => undefined) as Plugin.Function<void>)

  const integration = defineAgentLensIntegration({
    integrationId: 'test-assets',
    productId: 'test-assets',
    displayName: 'Assets Test',
    apiVersion: '1.0',
    capabilities: ['source', 'assets'],
    componentPluginIds: ['@agent-lens/test-assets-component'],
  }, [{
    pluginId: '@agent-lens/test-assets-component',
    capabilities: ['source', 'assets'],
    activation: 'catalog',
    lifecycle: 'plugin',
    plugin: component,
  }])

  const app = new AgentLensApplication()
  app.useIntegration(integration)
  await app.start()
  try {
    const status = app.integrationStatus('test-assets')
    assert.deepEqual(status?.capabilities.map(item => [
      item.capability,
      item.availability,
      item.authorization,
    ]), [
      ['source', 'available', undefined],
      ['assets', 'available', undefined],
    ])
    assert.deepEqual(app.authorizableCapabilities('test-assets'), [])
  } finally {
    await app.stop()
  }
})

test('third-party Live is discovered by product when integrationId differs from liveId', async () => {
  let ready = false
  const runtime = {
    runtimeSessionId: 'mock-session', status: 'ready' as const,
    isStreaming: false, pendingMessageCount: 0,
  }
  const adapter: LiveAdapter = {
    manifest: {
      pluginId: 'mock-third-party-live', pluginVersion: '1.0.0', apiVersion: '1.0',
      pluginType: 'live', displayName: 'Mock Live',
      liveId: 'custom-live-runtime', productId: 'mock-product',
      capabilities: ['create', 'send', 'stream'],
    },
    capabilities: new Set(['create', 'send', 'stream']),
    inputCapabilities: {
      text: 'native', largeText: 'unsupported', image: 'unsupported',
      file: 'unsupported', multiline: 'native',
    },
    startCapabilities: { workspace: 'unsupported', title: 'optional' },
    async availability() { return ready ? { available: true } : { available: false, reason: 'not ready' } },
    async list() { return [runtime] },
    async start() { return runtime },
    async state() { return runtime },
    async snapshot() { return { state: runtime, entries: [] } },
    async send() {},
    subscribe() { return () => {} },
    async terminate() {},
    async dispose() {},
  }

  const provideLives: Plugin.Function<void> = (ctx: AgentLensContext) => {
    const service = new DefaultLiveService()
    return ctx.provide('lives', service)
  }
  const registerLive: Plugin.Function<void> = (ctx: AgentLensContext) => {
    const registration = ctx.lives.register(adapter)
    return () => registration.dispose()
  }
  registerLive.inject = ['lives']

  const app = new AgentLensApplication()
  app.useRuntime(provideLives)
  app.useIntegration(defineAgentLensIntegration({
    integrationId: 'custom-integration', productId: 'mock-product',
    displayName: 'Mock Product', apiVersion: '1.0',
    capabilities: ['live'], componentPluginIds: ['mock-third-party-live'],
  }, [{
    pluginId: 'mock-third-party-live', capabilities: ['live'],
    activation: 'enabled', lifecycle: 'runtime', plugin: registerLive,
  }]))
  await app.start()
  try {
    assert.equal(app.context.get('lives')?.get('custom-live-runtime'), adapter)
    const unavailable = await app.resolveIntegrationStatus('mock-product')
    assert.equal(unavailable?.capabilities.find(item => item.capability === 'live')?.availability, 'unavailable')
    // Multiple independently registered Live implementations may share a
    // product. Do not guess one canonical liveId or let the first offline
    // adapter hide a second ready one.
    const second: LiveAdapter = {
      ...adapter,
      manifest: {
        ...adapter.manifest, pluginId: 'mock-second-live',
        liveId: 'another-third-party-live',
      },
      async availability() { return { available: true } },
    }
    const handle = app.context.get('lives')!.register(second)
    try {
      const aggregated = await app.resolveIntegrationStatus('mock-product')
      assert.equal(aggregated?.capabilities.find(item => item.capability === 'live')?.availability, 'available')
    } finally {
      handle.dispose()
    }
    ready = true
    const available = await app.resolveIntegrationStatus('mock-product')
    assert.equal(available?.capabilities.find(item => item.capability === 'live')?.availability, 'available')
  } finally {
    await app.stop()
  }
})
