import assert from 'node:assert/strict'
import test from 'node:test'
import type { HubReviewDetailDto } from '@agent-lens/protocol'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { startHttpSurface } from './server'

const remoteDetail: HubReviewDetailDto = {
  logicalSessionId: 'replica/session:node-a/native-session-1',
  origin: {
    kind: 'remote',
    nodeId: 'node-a',
    entityId: 'native-session-1',
    generationId: 'generation-2',
  },
  title: { state: 'omitted', reason: 'policy' },
  items: [{
    id: 'replica/observation:node-a/native-observation-1',
    origin: {
      kind: 'remote',
      nodeId: 'node-a',
      entityId: 'native-observation-1',
      generationId: 'generation-2',
    },
    kind: { state: 'value', value: 'message.user' },
    capturedAt: { state: 'value', value: '2026-08-28T00:00:00.000Z' },
    occurredAt: { state: 'null' },
    payload: { state: 'redacted' },
    references: {
      logicalSession: {
        entityType: 'LogicalSession',
        publicId: 'replica/session:node-a/native-session-1',
      },
    },
  }],
  meta: {
    count: 1,
    generatedAt: '2026-08-28T00:00:01.000Z',
  },
}

test('Hub Review route stays on loopback and preserves availability-aware DTO', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const requested: Array<{ id: string; limit: number | undefined }> = []
  const hubReview = {
    async get(id: string, limit?: number) {
      requested.push({ id, limit })
      return id === remoteDetail.logicalSessionId ? remoteDetail : null
    },
  }
  const surface = await startHttpSurface(storage, { port: 0, hubReview })

  try {
    assert.equal(surface.host, '127.0.0.1')
    const base = `http://${surface.host}:${surface.port}`
    const id = encodeURIComponent(remoteDetail.logicalSessionId)

    const response = await fetch(`${base}/api/v1/hub/review/${id}?limit=25`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), remoteDetail)
    assert.deepEqual(requested, [{ id: remoteDetail.logicalSessionId, limit: 25 }])

    const missing = await fetch(`${base}/api/v1/hub/review/${encodeURIComponent('replica/missing')}`)
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), { error: 'not_found' })

    const badLimit = await fetch(`${base}/api/v1/hub/review/${id}?limit=501`)
    assert.equal(badLimit.status, 400)
    assert.deepEqual(await badLimit.json(), {
      error: 'bad_request',
      message: 'Limit must be an integer between 1 and 500',
    })
  } finally {
    await surface.dispose()
    storage.close()
  }
})

test('Hub Review route reports unavailable when projection is not mounted', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const surface = await startHttpSurface(storage, { port: 0 })

  try {
    const base = `http://${surface.host}:${surface.port}`
    const response = await fetch(`${base}/api/v1/hub/review/${encodeURIComponent('replica/session')}`)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'hub_review_unavailable' })
  } finally {
    await surface.dispose()
    storage.close()
  }
})
