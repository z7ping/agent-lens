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

test('ReviewProjection evaluates error and latency filters against the complete session on the server', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'review-filter-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    let logicalSessionId = ''
    let sequence = 0
    const durations = [1, 2, 3, 20]

    for (let round = 1; round <= 4; round += 1) {
      const start = new Date(Date.UTC(2026, 7, 21, 5, round, 0, 0))
      sequence += 1
      const userId = `filter-user-${round}`
      const user = await observations.commit({
        sourceId: 'codex', host, installation,
        candidate: {
          kind: 'message.user', nativeEventId: userId, sourceSequence: sequence,
          occurredAt: start.toISOString(), capturedAt: start.toISOString(), payload: { text: `round-${round}` },
          identityHints: { nativeSessionId: 'review-filter-session' }, dedupHints: { nativeEventId: userId },
        },
        evidenceCandidates: [],
      })
      logicalSessionId ||= user.observation.logicalSessionId

      sequence += 1
      const end = new Date(start.getTime() + durations[round - 1]! * 1000)
      const resultId = `filter-result-${round}`
      await observations.commit({
        sourceId: 'codex', host, installation,
        candidate: {
          kind: 'tool.result', nativeEventId: resultId, nativeCallId: `call-${round}`, sourceSequence: sequence,
          occurredAt: end.toISOString(), capturedAt: end.toISOString(),
          payload: { callId: `call-${round}`, success: round === 2 || round === 4 ? false : true },
          identityHints: { nativeSessionId: 'review-filter-session' }, dedupHints: { nativeEventId: resultId },
        },
        evidenceCandidates: [],
      })
    }

    const projection = new ReviewProjection(storage)
    const firstErrors = await projection.get(logicalSessionId, { filter: 'errors', limit: 1 })
    assert.ok(firstErrors)
    assert.equal(firstErrors.page.filter, 'errors')
    assert.deepEqual(firstErrors.interactions.map(item => item.ordinal), [2])
    assert.equal(firstErrors.page.hasMore, true)
    assert.ok(firstErrors.page.nextCursor)

    const secondErrors = await projection.get(logicalSessionId, {
      filter: 'errors', cursor: firstErrors.page.nextCursor!, limit: 1,
    })
    assert.ok(secondErrors)
    assert.deepEqual(secondErrors.interactions.map(item => item.ordinal), [4])
    assert.equal(secondErrors.page.hasMore, false)

    const latency = await projection.get(logicalSessionId, { filter: 'latency', limit: 10 })
    assert.ok(latency)
    assert.equal(latency.page.filter, 'latency')
    assert.ok((latency.page.latencyThresholdMs ?? 0) > 0)
    assert.deepEqual(latency.interactions.map(item => item.ordinal), [4])

    const latest = await projection.get(logicalSessionId, { filter: 'latest' })
    assert.ok(latest)
    assert.equal(latest.page.filter, 'latest')
    assert.deepEqual(latest.interactions.map(item => item.ordinal), [4])
  } finally {
    storage.close()
  }
})
