import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultIdentityService, DefaultObservationService } from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { reviewProjectionInternals } from './index'

test('internal review result falls back to the review assistant output', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'review-activity-result-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    const at = '2026-09-04T00:00:00.000Z'
    const committed = await observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'message.assistant',
        nativeEventId: 'guardian-result',
        occurredAt: at,
        capturedAt: at,
        payload: { text: 'ALLOW：本次操作符合策略，可以继续。' },
        identityHints: { nativeSessionId: 'guardian-review-session' },
        dedupHints: { nativeEventId: 'guardian-result' },
      },
      evidenceCandidates: [],
    })

    const result = await reviewProjectionInternals.internalActivityResult(storage, {
      id: committed.observation.logicalSessionId,
      sessionActivity: 'internal-review',
      errorCount: 0,
    } as any)

    assert.equal(result.activityResult, 'ALLOW：本次操作符合策略，可以继续。')
    assert.equal(result.activityStatus, 'allowed')
  } finally {
    await storage.close()
  }
})
