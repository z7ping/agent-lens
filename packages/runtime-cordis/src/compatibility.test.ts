import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import type {
  SourceDefinition,
  SourceService,
  StorageService,
} from '@agent-lens/core'
import './context'
import { defineAgentLensPlugin, defineSourcePlugin } from './plugin'

const repositories = {} as StorageService['repositories']
const checkpoints: StorageService['checkpoints'] = {
  async get() {
    return null
  },
  async set() {},
  async clear() {},
}
const storage: StorageService = {
  repositories,
  checkpoints,
  async transaction<T>(
    fn: (tx: StorageService['repositories']) => Promise<T>,
  ): Promise<T> {
    return fn(repositories)
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

test('SourceDefinition is adapted to Cordis inside the runtime boundary', async () => {
  const root = new Context()
  let registered: SourceDefinition | null = null
  let disposed = false

  const sources: SourceService = {
    register(definition) {
      registered = definition
      return {
        dispose() {
          disposed = true
          registered = null
        },
      }
    },
    list() {
      return registered ? [registered] : []
    },
    async detect() {
      return []
    },
  }

  const provider: Plugin.Function<void> = (ctx) => {
    ctx.provide('sources', sources)
  }

  const definition: SourceDefinition = {
    manifest: {
      pluginId: '@agent-lens/test-source',
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'Test Source',
      sourceId: 'test-source',
      productId: 'test-source',
      parserVersion: '1',
    },
    async detect() {
      return []
    },
    async declareCapabilities() {
      return []
    },
    async normalize() {
      return { observations: [], evidenceCandidates: [] }
    },
  }

  const providerFiber = await root.plugin(provider)
  const sourceFiber = await root.plugin(defineSourcePlugin(definition))

  assert.equal(registered, definition)

  await sourceFiber.dispose()
  assert.equal(disposed, true)
  assert.equal(registered, null)
  await providerFiber.dispose()
})
