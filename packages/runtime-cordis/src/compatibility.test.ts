import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import type { StorageService } from '@agent-lens/core'
import './context'
import { defineAgentLensPlugin } from './plugin'

const storage: StorageService = {
  async transaction<T>(fn: (tx: {}) => Promise<T>): Promise<T> {
    return fn({})
  },
  async migrate(): Promise<void> {},
  async health() {
    return { ok: true }
  },
}

test('Cordis provide/inject/fiber lifecycle stays compatible with AgentLens', async () => {
  const events: string[] = []
  const root = new Context()

  const provider: Plugin.Function<void> = (ctx) => {
    events.push('provider:start')
    ctx.provide('storage', storage)
    return () => {
      events.push('provider:stop')
    }
  }

  const consumer: Plugin.Function<void> = async (ctx) => {
    events.push('consumer:start')
    assert.deepEqual(await ctx.storage.health(), { ok: true })
    return () => {
      events.push('consumer:stop')
    }
  }
  consumer.inject = ['storage']

  const providerFiber = await root.plugin(provider)
  const consumerFiber = await root.plugin(consumer)

  assert.deepEqual(events, ['provider:start', 'consumer:start'])

  await consumerFiber.dispose()
  await providerFiber.dispose()

  assert.deepEqual(events, [
    'provider:start',
    'consumer:start',
    'consumer:stop',
    'provider:stop',
  ])
})

test('AgentLens plugin metadata rejects incompatible API versions', () => {
  const plugin: Plugin.Function<void> = () => undefined

  assert.throws(
    () => defineAgentLensPlugin({
      pluginId: '@agent-lens/test-incompatible',
      pluginVersion: '1.0.0',
      apiVersion: '999',
      pluginType: 'surface',
      displayName: 'Incompatible Test Plugin',
    }, plugin),
    /Unsupported AgentLens Plugin API/,
  )
})
