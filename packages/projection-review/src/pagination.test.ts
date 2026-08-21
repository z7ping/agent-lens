import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultIdentityService, DefaultObservationService } from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { ReviewProjection } from './index'

test('ReviewProjection paginates only on complete interaction boundaries', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'review-pagination-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    let sequence = 0
    let logicalSessionId = ''

    const add = async (kind: 'message.user' | 'message.assistant' | 'unknown', text: string) => {
      sequence += 1
      const at = new Date(Date.UTC(2026, 7, 21, 3, 0, 0, sequence)).toISOString()
      const nativeEventId = `page-${sequence}`
      const result = await observations.commit({
        sourceId: 'codex', host, installation,
        candidate: {
          kind, nativeEventId, sourceSequence: sequence, occurredAt: at, capturedAt: at,
          payload: { text }, identityHints: { nativeSessionId: 'review-pagination-session' },
          dedupHints: { nativeEventId },
        },
        evidenceCandidates: [],
      })
      logicalSessionId ||= result.observation.logicalSessionId
    }

    await add('message.user', '第一轮')
    for (let index = 0; index < 260; index += 1) await add('unknown', `事件 ${index}`)
    await add('message.user', '第二轮')
    await add('message.assistant', '第二轮回复')
    await add('message.user', '第三轮')

    const projection = new ReviewProjection(storage)
    const first = await projection.get(logicalSessionId, { limit: 1 })
    assert.ok(first)
    assert.equal(first.interactions[0]?.ordinal, 1)
    assert.equal(first.interactions[0]?.nodes.length, 261)
    assert.equal(first.page.hasMore, true)
    assert.ok(first.page.nextCursor)

    const second = await projection.get(logicalSessionId, { limit: 1, cursor: first.page.nextCursor })
    assert.ok(second)
    assert.equal(second.interactions[0]?.ordinal, 2)
    assert.equal(second.interactions[0]?.nodes.length, 2)
    assert.equal(second.page.hasMore, true)
    assert.ok(second.page.nextCursor)

    const third = await projection.get(logicalSessionId, { limit: 1, cursor: second.page.nextCursor })
    assert.ok(third)
    assert.equal(third.interactions[0]?.ordinal, 3)
    assert.equal(third.page.hasMore, false)
  } finally {
    storage.close()
  }
})
