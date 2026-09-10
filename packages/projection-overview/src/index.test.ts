import assert from 'node:assert/strict'
import test from 'node:test'
import type { CapturePolicyService, SourceService } from '@agent-lens/core'
import { DefaultIdentityService } from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { AgentOverviewProjection, FacetProjection } from './index'

const sources = {
  list: () => [{
    manifest: {
      pluginId: '@agent-lens/source-codex',
      pluginVersion: '1.0.0-alpha.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'Codex Source',
      sourceId: 'codex',
      productId: 'codex',
      parserVersion: '1',
    },
  }],
} as unknown as SourceService

function policy(enabled: boolean): CapturePolicyService {
  return {
    isSourceEnabled(sourceId: string) {
      return sourceId === 'codex' && enabled
    },
  } as unknown as CapturePolicyService
}

test('AgentOverviewProjection keeps inventory state separate from observed usage', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const host = await identity.resolveHost({ name: 'overview-host' })
    const installation = await identity.resolveInstallation({
      hostId: host.id,
      productId: 'codex',
      version: '1.2.3',
      configRoot: '/tmp/.codex',
    })

    await storage.repositories.assets.putDefinition({
      id: 'asset:skill:review',
      type: 'skill',
      canonicalName: 'review',
      displayName: 'Review Skill',
    })
    await storage.repositories.assets.putBinding({
      id: 'binding:skill:review',
      assetId: 'asset:skill:review',
      installationId: installation.id,
      path: '/tmp/.codex/skills/review',
    })
    await storage.repositories.assets.putState({
      id: 'state:skill:review:installed',
      assetBindingId: 'binding:skill:review',
      state: 'installed',
      value: true,
      observedAt: '2026-08-21T03:00:00.000Z',
      evidenceRefs: ['evidence:scan'],
    })

    const response = await new AgentOverviewProjection(storage, sources).query()
    assert.equal(response.items.length, 1)
    const agent = response.items[0]!
    assert.equal(agent.sourceId, 'codex')
    assert.equal(agent.enabled, true)
    assert.equal(agent.detected, true)
    assert.equal(agent.assetInventoryStatus, 'available')
    assert.equal(agent.assetInventory.length, 1)
    assert.equal(agent.assetInventory[0]?.canonicalName, 'review')
    assert.deepEqual(agent.assetInventory[0]?.bindings[0]?.states, [{
      state: 'installed',
      value: true,
      observedAt: '2026-08-21T03:00:00.000Z',
      evidenceCount: 1,
    }])
    assert.deepEqual(agent.usedAssets, [])
  } finally {
    storage.close()
  }
})

test('AgentOverview 只展示当前仍存在的资产，已安装但禁用的资产仍保留', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const host = await identity.resolveHost({ name: 'inventory-current-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })

    for (const name of ['removed', 'disabled']) {
      await storage.repositories.assets.putDefinition({
        id: `asset:skill:${name}`,
        type: 'skill',
        canonicalName: name,
      })
      await storage.repositories.assets.putBinding({
        id: `binding:skill:${name}`,
        assetId: `asset:skill:${name}`,
        installationId: installation.id,
        path: `/tmp/.codex/skills/${name}`,
      })
    }

    await storage.repositories.assets.putState({
      id: 'state:removed:installed:true',
      assetBindingId: 'binding:skill:removed',
      state: 'installed',
      value: true,
      observedAt: '2026-09-10T01:00:00.000Z',
      evidenceRefs: [],
    })
    await storage.repositories.assets.putState({
      id: 'state:removed:installed:false',
      assetBindingId: 'binding:skill:removed',
      state: 'installed',
      value: false,
      observedAt: '2026-09-10T02:00:00.000Z',
      evidenceRefs: [],
    })
    await storage.repositories.assets.putState({
      id: 'state:removed:discoverable:false',
      assetBindingId: 'binding:skill:removed',
      state: 'discoverable',
      value: false,
      observedAt: '2026-09-10T02:00:00.000Z',
      evidenceRefs: [],
    })

    await storage.repositories.assets.putState({
      id: 'state:disabled:installed:true',
      assetBindingId: 'binding:skill:disabled',
      state: 'installed',
      value: true,
      observedAt: '2026-09-10T02:00:00.000Z',
      evidenceRefs: [],
    })
    await storage.repositories.assets.putState({
      id: 'state:disabled:enabled:false',
      assetBindingId: 'binding:skill:disabled',
      state: 'enabled',
      value: false,
      observedAt: '2026-09-10T02:00:00.000Z',
      evidenceRefs: [],
    })

    const response = await new AgentOverviewProjection(storage, sources).query()
    const inventory = response.items[0]?.assetInventory ?? []
    assert.deepEqual(inventory.map(item => item.canonicalName), ['disabled'])
    assert.equal(inventory[0]?.bindings[0]?.states.find(state => state.state === 'enabled')?.value, false)
  } finally {
    storage.close()
  }
})

test('AgentOverview 与 Facet 使用采集策略报告真实 enabled 状态', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const disabled = policy(false)
    const overview = await new AgentOverviewProjection(storage, sources, undefined, disabled).query()
    const facets = await new FacetProjection(storage, sources, disabled).query()

    assert.equal(overview.items[0]?.sourceId, 'codex')
    assert.equal(overview.items[0]?.supported, true)
    assert.equal(overview.items[0]?.enabled, false)
    assert.equal(facets.agents[0]?.sourceId, 'codex')
    assert.equal(facets.agents[0]?.enabled, false)
  } finally {
    storage.close()
  }
})

test('当前检测结果覆盖历史 Installation，并可通过 invalidate 立即刷新', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const host = await identity.resolveHost({ name: 'detection-current-host' })
    await identity.resolveInstallation({ hostId: host.id, productId: 'codex', version: '1.0.0' })

    let currentlyDetected = false
    const resolver = () => currentlyDetected
    const overviewProjection = new AgentOverviewProjection(storage, sources, undefined, undefined, resolver)
    const facetProjection = new FacetProjection(storage, sources, undefined, resolver)

    assert.equal((await overviewProjection.query()).items[0]?.detected, false)
    assert.equal((await facetProjection.query()).agents[0]?.detected, false)

    currentlyDetected = true
    overviewProjection.invalidate()
    facetProjection.invalidate()

    assert.equal((await overviewProjection.query()).items[0]?.detected, true)
    assert.equal((await facetProjection.query()).agents[0]?.detected, true)
  } finally {
    storage.close()
  }
})

test('FacetProjection collapses concurrent identical queries into one build', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const original = storage.repositories.installations.listByProduct.bind(storage.repositories.installations)
    let reads = 0
    storage.repositories.installations.listByProduct = async productId => {
      reads += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return original(productId)
    }

    const projection = new FacetProjection(storage, sources)
    const results = await Promise.all(Array.from({ length: 64 }, () => projection.query()))
    assert.equal(results.length, 64)
    assert.equal(reads, 1)
  } finally {
    storage.close()
  }
})

test('AgentOverviewProjection collapses concurrent identical queries into one build', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const original = storage.repositories.installations.listByProduct.bind(storage.repositories.installations)
    let reads = 0
    storage.repositories.installations.listByProduct = async productId => {
      reads += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return original(productId)
    }

    const projection = new AgentOverviewProjection(storage, sources)
    const results = await Promise.all(Array.from({ length: 64 }, () => projection.query()))
    assert.equal(results.length, 64)
    assert.equal(reads, 1)
  } finally {
    storage.close()
  }
})
