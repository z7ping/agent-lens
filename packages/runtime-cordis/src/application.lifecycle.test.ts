import assert from 'node:assert/strict'
import test from 'node:test'
import type { Plugin } from '@deepseek-ai/cordis'
import { AgentLensApplication } from './application'
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
