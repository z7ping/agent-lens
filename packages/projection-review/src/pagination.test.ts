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
    assert.equal(first.page.direction, 'forward')
    assert.equal(first.page.filter, 'all')
    assert.equal(first.page.hasMore, true)
    assert.ok(first.page.nextCursor)

    const second = await projection.get(logicalSessionId, { limit: 1, cursor: first.page.nextCursor! })
    assert.ok(second)
    assert.equal(second.interactions[0]?.ordinal, 2)
    assert.equal(second.interactions[0]?.nodes.length, 2)
    assert.equal(second.page.hasMore, true)
    assert.ok(second.page.nextCursor)

    const third = await projection.get(logicalSessionId, { limit: 1, cursor: second.page.nextCursor! })
    assert.ok(third)
    assert.equal(third.interactions[0]?.ordinal, 3)
    assert.equal(third.page.hasMore, false)

    const jumped = await projection.get(logicalSessionId, { ordinal: 2 })
    assert.ok(jumped)
    assert.deepEqual(jumped.interactions.map(item => item.ordinal), [2])
    assert.equal(jumped.page.count, 1)
    assert.equal(jumped.page.hasMore, false)
    assert.ok(jumped.interactionIndex)
    assert.deepEqual(jumped.interactionIndex.map(item => item.ordinal), [1, 2, 3])
  } finally {
    storage.close()
  }
})

test('ReviewProjection can jump to the latest rounds and page backward by complete interactions', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'review-backward-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    let logicalSessionId = ''
    let sequence = 0

    for (let round = 1; round <= 5; round += 1) {
      for (const kind of ['message.user', 'message.assistant'] as const) {
        sequence += 1
        const at = new Date(Date.UTC(2026, 7, 21, 4, 0, 0, sequence)).toISOString()
        const nativeEventId = `backward-${sequence}`
        const result = await observations.commit({
          sourceId: 'codex', host, installation,
          candidate: {
            kind, nativeEventId, sourceSequence: sequence, occurredAt: at, capturedAt: at,
            payload: { text: `${round}-${kind}` },
            identityHints: { nativeSessionId: 'review-backward-session' },
            dedupHints: { nativeEventId },
          },
          evidenceCandidates: [],
        })
        logicalSessionId ||= result.observation.logicalSessionId
      }
    }

    const projection = new ReviewProjection(storage)
    const latest = await projection.get(logicalSessionId, { direction: 'backward', limit: 2 })
    assert.ok(latest)
    assert.equal(latest.page.direction, 'backward')
    assert.deepEqual(latest.interactions.map(item => item.ordinal), [4, 5])
    assert.equal(latest.page.hasMore, true)
    assert.ok(latest.page.nextCursor)

    const older = await projection.get(logicalSessionId, {
      direction: 'backward',
      cursor: latest.page.nextCursor!,
      limit: 2,
    })
    assert.ok(older)
    assert.deepEqual(older.interactions.map(item => item.ordinal), [2, 3])
    assert.equal(older.page.hasMore, true)
    assert.ok(older.page.nextCursor)

    const oldest = await projection.get(logicalSessionId, {
      direction: 'backward',
      cursor: older.page.nextCursor!,
      limit: 2,
    })
    assert.ok(oldest)
    assert.deepEqual(oldest.interactions.map(item => item.ordinal), [1])
    assert.equal(oldest.page.hasMore, false)
  } finally {
    storage.close()
  }
})
