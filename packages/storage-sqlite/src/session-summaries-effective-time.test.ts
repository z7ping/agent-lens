import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultIdentityService, DefaultObservationService } from '@agent-lens/core-services'
import { SqliteStorageService } from './storage'

test('session summary activity time follows row-wise occurredAt/capturedAt effective time', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'summary-effective-time-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'pi' })

    const commit = async (
      nativeSessionId: string,
      nativeEventId: string,
      capturedAt: string,
      kind: 'message.user' | 'message.assistant',
      occurredAt?: string,
    ) => observations.commit({
      sourceId: 'pi', host, installation,
      candidate: {
        kind,
        nativeEventId,
        ...(occurredAt ? { occurredAt } : {}),
        capturedAt,
        payload: kind === 'message.user'
          ? { text: nativeEventId, provenance: { actualAuthor: 'human-user', contentRole: 'user-request' } }
          : { text: nativeEventId },
        identityHints: { nativeSessionId },
        dedupHints: { nativeEventId },
      },
      evidenceCandidates: [],
    })

    const resumed = await commit('old-resumed', 'old-start', '2026-08-01T08:00:00.000Z', 'message.user')
    await commit('old-resumed', 'old-middle', '2026-09-04T08:00:00.000Z', 'message.assistant', '2026-09-04T08:00:00.000Z')
    await commit('old-resumed', 'old-latest-captured-only', '2026-09-06T08:00:00.000Z', 'message.assistant')
    const recent = await commit('recent-session', 'recent-start', '2026-09-05T08:00:00.000Z', 'message.user', '2026-09-05T08:00:00.000Z')

    for (const materialized of [false, true]) {
      if (materialized) await storage.sessionSummaryProjection.rebuild()
      const page = await storage.sessionSummaries.query({ from: '2026-09-01T00:00:00.000Z', limit: 10 })
      assert.deepEqual(page.items.map(item => item.logicalSessionId), [
        resumed.observation.logicalSessionId,
        recent.observation.logicalSessionId,
      ])
      assert.equal(page.items[0]?.startedAt, '2026-08-01T08:00:00.000Z')
      assert.equal(page.items[0]?.endedAt, '2026-09-06T08:00:00.000Z')
    }
  } finally {
    await storage.close()
  }
})
