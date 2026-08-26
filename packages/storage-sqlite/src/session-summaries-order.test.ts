import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultIdentityService, DefaultObservationService } from '@agent-lens/core-services'
import { SqliteStorageService } from './storage'

test('session summary projection preserves ordering and can rebuild one session', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'dogfood-host', platform: 'win32', arch: 'x64' })
    const installation = await identity.resolveInstallation({
      hostId: host.id,
      productId: 'codex',
      configRoot: 'C:\\Users\\test\\.codex',
    })

    const commitMessage = async (nativeSessionId: string, occurredAt: string, text: string) => observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'message.user',
        nativeEventId: `${nativeSessionId}:${occurredAt}`,
        occurredAt,
        capturedAt: occurredAt,
        payload: { text },
        identityHints: { nativeSessionId },
        dedupHints: { nativeEventId: `${nativeSessionId}:${occurredAt}` },
      },
      evidenceCandidates: [],
    })

    const older = await commitMessage('session-older', '2026-08-25T10:00:00.000Z', '较早会话')
    await commitMessage('session-newer', '2026-08-25T10:05:00.000Z', '较新会话')

    const fallback = await storage.sessionSummaries.query({ limit: 10 })
    assert.equal(fallback.items.length, 2)
    assert.equal(fallback.items[0]?.endedAt, '2026-08-25T10:05:00.000Z')

    await storage.sessionSummaryProjection.rebuild()
    assert.equal(Number((storage.db.prepare('SELECT COUNT(*) AS count FROM session_summary_projection').get() as { count: number }).count), 2)

    const projected = await storage.sessionSummaries.query({ limit: 10 })
    assert.deepEqual(
      projected.items.map(item => [item.logicalSessionId, item.endedAt, item.observationCount]),
      fallback.items.map(item => [item.logicalSessionId, item.endedAt, item.observationCount]),
    )

    await commitMessage('session-older', '2026-08-25T10:10:00.000Z', '较早会话后来又有新消息')
    await storage.sessionSummaryProjection.rebuild({ logicalSessionId: older.observation.logicalSessionId })

    const refreshed = await storage.sessionSummaries.query({ limit: 10 })
    assert.equal(refreshed.items[0]?.logicalSessionId, older.observation.logicalSessionId)
    assert.equal(refreshed.items[0]?.endedAt, '2026-08-25T10:10:00.000Z')
    assert.equal(refreshed.items[0]?.observationCount, 2)
    assert.equal(refreshed.items[1]?.endedAt, '2026-08-25T10:05:00.000Z')
  } finally {
    storage.close()
  }
})
