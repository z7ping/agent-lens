import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AgentInstallation,
  AssetBinding,
  AssetDefinition,
  AssetService,
  AssetStateInput,
  CapturePolicyService,
  CapabilityService,
  DetectedSource,
  DiscoveredAsset,
  EvidenceService,
  Host,
  IdentityService,
  SourceDefinition,
  StorageService,
} from '@agent-lens/core'
import { SourceAssetRunner } from './source-runner'

const host: Host = {
  id: 'host-asset-scan',
  name: 'test-host',
  platform: 'linux',
  arch: 'x64',
  createdAt: '2026-09-10T00:00:00.000Z',
  lastSeenAt: '2026-09-10T00:00:00.000Z',
}

const installation: AgentInstallation = {
  id: 'installation-asset-scan',
  hostId: host.id,
  productId: 'test-product',
  firstSeenAt: '2026-09-10T00:00:00.000Z',
  lastSeenAt: '2026-09-10T00:00:00.000Z',
}

const detected: DetectedSource = {
  sourceId: 'test-source',
  productId: 'test-product',
  confidence: 'exact',
}

function sourceWithInventory(inventory: { current: boolean; discoverable?: boolean }): SourceDefinition {
  return {
    manifest: {
      pluginId: 'test-source-plugin',
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'Test Source',
      sourceId: 'test-source',
      productId: 'test-product',
      parserVersion: '1',
    },
    async detect() { return [detected] },
    async declareCapabilities() { return [] },
    async *discoverAssets() {
      if (!inventory.current) return
      const states: NonNullable<DiscoveredAsset['states']> = [{
        state: 'installed',
        value: true,
        observedAt: '2026-09-10T01:00:00.000Z',
      }]
      if (inventory.discoverable) {
        states.push({
          state: 'discoverable',
          value: true,
          observedAt: '2026-09-10T01:00:00.000Z',
        })
      }
      yield {
        definition: {
          type: 'skill',
          canonicalName: 'skill-one',
          displayName: 'Skill One',
        },
        binding: {
          path: '/tmp/skills/skill-one',
          source: 'test:skills',
        },
        states,
      }
    },
    async normalize() { return { observations: [], evidenceCandidates: [] } },
  }
}

function harness() {
  const checkpoints = new Map<string, unknown>()
  const writes: AssetStateInput[] = []
  const definition: AssetDefinition = {
    id: 'asset-skill-one',
    type: 'skill',
    canonicalName: 'skill-one',
    displayName: 'Skill One',
  }
  const binding: AssetBinding = {
    id: 'binding-skill-one',
    assetId: definition.id,
    installationId: installation.id,
    path: '/tmp/skills/skill-one',
    source: 'test:skills',
  }

  const storage = {
    checkpoints: {
      async get<T>(scope: string, key: string) {
        return (checkpoints.get(`${scope}:${key}`) as T | undefined) ?? null
      },
      async set<T>(scope: string, key: string, value: T) {
        checkpoints.set(`${scope}:${key}`, structuredClone(value))
      },
      async clear(scope: string, key: string) {
        checkpoints.delete(`${scope}:${key}`)
      },
    },
  } as unknown as StorageService
  const assets = {
    async resolveDefinition() { return definition },
    async resolveBinding() { return binding },
    async recordState(input: AssetStateInput) {
      writes.push(structuredClone(input))
      return {
        id: `state-${writes.length}`,
        ...input,
      }
    },
  } as unknown as AssetService
  const runner = new SourceAssetRunner(
    storage,
    { async resolveInstallation() { return installation } } as unknown as IdentityService,
    { registerSourceCapabilities() { return { dispose() {} } } } as unknown as CapabilityService,
    assets,
    { async create() { throw new Error('No evidence expected') } } as unknown as EvidenceService,
    {
      isEnabled(scope: string) { return scope === 'config' },
      sanitizeDiscoveredAsset(value: unknown) { return value },
    } as unknown as CapturePolicyService,
  )

  return { runner, writes }
}

test('资产扫描不再把未声明 discoverable 自动提升为 true', async () => {
  const inventory = { current: true }
  const { runner, writes } = harness()
  const source = sourceWithInventory(inventory)
  const signal = new AbortController().signal

  const first = await runner.scan({ source, host, detected, abortSignal: signal })
  assert.equal(first.assetsDiscovered, 1)
  assert.equal(first.assetsRemoved, 0)
  assert.equal(first.statesCleared, 0)
  assert.deepEqual(
    writes.map(item => [item.state, item.value]),
    [['installed', true]],
  )

  writes.length = 0
  inventory.current = false
  const second = await runner.scan({ source, host, detected, abortSignal: signal })

  assert.equal(second.assetsDiscovered, 0)
  assert.equal(second.assetsRemoved, 1)
  assert.equal(second.statesCleared, 1)
  assert.deepEqual(
    writes.map(item => [item.state, item.value]),
    [['installed', false]],
  )
})

test('资产消失时只对库存状态写 false，运行/发现状态退回 unknown', async () => {
  const inventory = { current: true, discoverable: true }
  const { runner, writes } = harness()
  const source = sourceWithInventory(inventory)
  const signal = new AbortController().signal

  const first = await runner.scan({ source, host, detected, abortSignal: signal })
  assert.equal(first.statesRecorded, 2)
  assert.deepEqual(
    writes.map(item => [item.state, item.value]).sort(),
    [['discoverable', true], ['installed', true]],
  )

  writes.length = 0
  inventory.current = false
  const second = await runner.scan({ source, host, detected, abortSignal: signal })

  assert.equal(second.assetsRemoved, 1)
  assert.equal(second.statesCleared, 2)
  assert.deepEqual(
    writes.map(item => [item.state, item.value]).sort(),
    [['discoverable', 'unknown'], ['installed', false]],
  )
})


test('同一资产仍存在但不再声明旧状态时，旧状态退回 unknown', async () => {
  const inventory = { current: true, discoverable: true }
  const { runner, writes } = harness()
  const source = sourceWithInventory(inventory)
  const signal = new AbortController().signal

  await runner.scan({ source, host, detected, abortSignal: signal })
  writes.length = 0

  inventory.discoverable = false
  const second = await runner.scan({ source, host, detected, abortSignal: signal })

  assert.equal(second.assetsDiscovered, 1)
  assert.equal(second.assetsRemoved, 0)
  assert.equal(second.statesCleared, 1)
  assert.deepEqual(
    writes.map(item => [item.state, item.value]),
    [['installed', true], ['discoverable', 'unknown']],
  )
})
