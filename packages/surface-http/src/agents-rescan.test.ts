import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceService } from '@agent-lens/core'
import { DefaultIdentityService } from '@agent-lens/core-services'
import type { AgentOverviewResponseDto, AgentRescanResponseDto } from '@agent-lens/protocol'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { startHttpSurface } from './server'

const sources = {
  list: () => [{
    manifest: {
      pluginId: '@agent-lens/source-codex',
      pluginVersion: '1.0.0-alpha.5',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'Codex Source',
      sourceId: 'codex',
      productId: 'codex',
      parserVersion: '1',
    },
  }],
} as unknown as SourceService

test('POST /agents/rescan invalidates cached overview and returns current detection state', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const identity = new DefaultIdentityService(storage)
  const host = await identity.resolveHost({ name: 'agents-rescan-http-host' })
  await identity.resolveInstallation({ hostId: host.id, productId: 'codex', version: '1.0.0' })

  let detected = true
  const surface = await startHttpSurface(storage, {
    port: 0,
    sources,
    sourceDetection: () => detected,
    rescanAgents: async () => {
      detected = false
      return {
        status: 'completed',
        startedAt: '2026-09-10T10:00:00.000Z',
        completedAt: '2026-09-10T10:00:01.000Z',
        sourcesDetected: 0,
        assetSourcesScanned: 0,
        assetsDiscovered: 0,
        assetsRemoved: 0,
        statesRecorded: 0,
        statesCleared: 0,
        failures: [],
      }
    },
  })

  try {
    const base = `http://${surface.host}:${surface.port}`
    const before = await fetch(`${base}/api/v1/agents`)
    assert.equal(before.status, 200)
    assert.equal((await before.json() as AgentOverviewResponseDto).items[0]?.detected, true)

    const rescanned = await fetch(`${base}/api/v1/agents/rescan`, { method: 'POST' })
    assert.equal(rescanned.status, 200)
    const body = await rescanned.json() as AgentRescanResponseDto
    assert.equal(body.status, 'completed')
    assert.equal(body.agents.items[0]?.detected, false)
    assert.equal(body.facets.agents[0]?.detected, false)

    const after = await fetch(`${base}/api/v1/agents`)
    assert.equal(after.status, 200)
    assert.equal((await after.json() as AgentOverviewResponseDto).items[0]?.detected, false)
  } finally {
    await surface.dispose()
    storage.close()
  }
})
