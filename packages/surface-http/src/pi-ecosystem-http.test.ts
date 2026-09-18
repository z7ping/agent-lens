import assert from 'node:assert/strict'
import test from 'node:test'
import type { PiEcosystemQueryService } from '@agent-lens/protocol'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { startHttpSurface } from './server'

test('Pi ecosystem HTTP surface forwards validated read-only catalog requests', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const received: unknown[] = []
  const service: PiEcosystemQueryService = {
    async search(request = {}) {
      received.push({ kind: 'search', request })
      return {
        query: request.query ?? '',
        ...(request.type ? { type: request.type } : {}),
        sort: request.sort ?? 'downloads',
        items: [],
        upstreamTotal: 0,
        source: 'npm-registry',
        fetchedAt: '2026-09-17T00:00:00.000Z',
        stale: false,
        meta: { protocolVersion: '1.0' },
      }
    },
    async packageDetails(request) {
      received.push({ kind: 'details', request })
      return {
        packageSource: `npm:${request.packageName}`,
        packageName: request.packageName,
        version: request.version,
        resourceTypes: ['skill'],
      }
    },
  }
  const surface = await startHttpSurface(storage, { port: 0, piEcosystem: service })
  const base = `http://${surface.host}:${surface.port}`

  try {
    const response = await fetch(`${base}/api/v1/integrations/pi/ecosystem?query=mcp&type=skill&sort=recent&limit=7`)
    assert.equal(response.status, 200)
    assert.deepEqual(received[0], {
      kind: 'search',
      request: { query: 'mcp', type: 'skill', sort: 'recent', limit: 7 },
    })

    const details = await fetch(`${base}/api/v1/integrations/pi/ecosystem/package?name=%40example%2Fpi-tools&version=1.2.3`)
    assert.equal(details.status, 200)
    assert.deepEqual(received[1], {
      kind: 'details',
      request: { packageName: '@example/pi-tools', version: '1.2.3' },
    })

    const invalidType = await fetch(`${base}/api/v1/integrations/pi/ecosystem?type=plugin`)
    assert.equal(invalidType.status, 400)

    const invalidSort = await fetch(`${base}/api/v1/integrations/pi/ecosystem?sort=popular`)
    assert.equal(invalidSort.status, 400)

    const invalidLimit = await fetch(`${base}/api/v1/integrations/pi/ecosystem?limit=100`)
    assert.equal(invalidLimit.status, 400)

    const invalidDetails = await fetch(`${base}/api/v1/integrations/pi/ecosystem/package?name=pi-demo`)
    assert.equal(invalidDetails.status, 400)

    const writeAttempt = await fetch(`${base}/api/v1/integrations/pi/ecosystem`, { method: 'POST' })
    assert.equal(writeAttempt.status, 405)
  } finally {
    await surface.dispose()
    await storage.close()
  }
})

test('Pi ecosystem HTTP surface keeps provider absence explicit', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const surface = await startHttpSurface(storage, { port: 0 })
  const base = `http://${surface.host}:${surface.port}`

  try {
    const response = await fetch(`${base}/api/v1/integrations/pi/ecosystem`)
    assert.equal(response.status, 503)
    const body = await response.json() as { error?: string }
    assert.equal(body.error, 'pi_ecosystem_unavailable')
  } finally {
    await surface.dispose()
    await storage.close()
  }
})
