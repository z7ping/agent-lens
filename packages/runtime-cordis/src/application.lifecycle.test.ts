import assert from 'node:assert/strict'
import test from 'node:test'
import type { Plugin } from '@deepseek-ai/cordis'
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
