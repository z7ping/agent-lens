import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultIdentityService, DefaultObservationService } from '@agent-lens/core-services'
import { SqliteStorageService } from './storage'

test('session summaries filter, sort and paginate by latest activity time', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'activity-order-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'pi' })

    const commit = async (nativeSessionId: string, occurredAt: string, text: string) => observations.commit({
      sourceId: 'pi',
      host,
      installation,
      candidate: {
        kind: 'message.user',
        nativeEventId: `${nativeSessionId}:${occurredAt}`,
        occurredAt,
        capturedAt: occurredAt,
        payload: { text, provenance: { actualAuthor: 'human-user', contentRole: 'user-request' } },
        identityHints: { nativeSessionId },
        dedupHints: { nativeEventId: `${nativeSessionId}:${occurredAt}` },
      },
      evidenceCandidates: [],
    })

    const resumed = await commit('old-but-resumed', '2026-08-01T08:00:00.000Z', '旧会话第一次消息')
    await commit('old-but-resumed', '2026-09-04T08:00:00.000Z', '今天恢复旧会话')
    const recent = await commit('recent-session', '2026-09-03T08:00:00.000Z', '昨天的新会话')
    await commit('stale-session', '2026-08-10T08:00:00.000Z', '真正过期的会话')

    for (const materialized of [false, true]) {
      if (materialized) await storage.sessionSummaryProjection.rebuild()

      const page = await storage.sessionSummaries.query({
        from: '2026-09-01T00:00:00.000Z',
        limit: 10,
      })
      assert.deepEqual(page.items.map(item => item.logicalSessionId), [
        resumed.observation.logicalSessionId,
        recent.observation.logicalSessionId,
      ])
      assert.equal(page.items[0]?.startedAt, '2026-08-01T08:00:00.000Z')
      assert.equal(page.items[0]?.endedAt, '2026-09-04T08:00:00.000Z')

      const firstPage = await storage.sessionSummaries.query({
        from: '2026-09-01T00:00:00.000Z',
        limit: 1,
      })
      const first = firstPage.items[0]!
      assert.equal(first.logicalSessionId, resumed.observation.logicalSessionId)
      assert.equal(firstPage.hasMore, true)

      const secondPage = await storage.sessionSummaries.query({
        from: '2026-09-01T00:00:00.000Z',
        limit: 1,
        after: { activeAt: first.endedAt, logicalSessionId: first.logicalSessionId },
      })
      assert.deepEqual(secondPage.items.map(item => item.logicalSessionId), [recent.observation.logicalSessionId])
      assert.equal(secondPage.hasMore, false)

      const legacyCursorPage = await storage.sessionSummaries.query({
        from: '2026-09-01T00:00:00.000Z',
        limit: 1,
        after: { startedAt: first.endedAt, logicalSessionId: first.logicalSessionId },
      })
      assert.deepEqual(legacyCursorPage.items.map(item => item.logicalSessionId), [recent.observation.logicalSessionId])
    }
  } finally {
    await storage.close()
  }
})
