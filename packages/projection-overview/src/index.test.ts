import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceService } from '@agent-lens/core'
import { DefaultIdentityService } from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { AgentOverviewProjection } from './index'

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
