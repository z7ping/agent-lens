import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultIdentityService, DefaultObservationService } from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { ReviewProjection } from './index'

test('Review backward ordinal uses Review interaction count instead of real-user turn count', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'review-ordinal-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    const nativeSessionId = 'review-ordinal-session'
    let logicalSessionId = ''
    let sequence = 0

    const addUser = async (text: string, actualAuthor: string, contentRole: string) => {
      sequence += 1
      const at = new Date(Date.UTC(2026, 8, 7, 12, 0, sequence)).toISOString()
      const nativeEventId = `ordinal-${sequence}`
      const result = await observations.commit({
        sourceId: 'codex', host, installation,
        candidate: {
          kind: 'message.user',
          nativeEventId,
          sourceSequence: sequence,
          occurredAt: at,
          capturedAt: at,
          payload: { text, provenance: { actualAuthor, contentRole } },
          identityHints: { nativeSessionId },
          dedupHints: { nativeEventId },
        },
        evidenceCandidates: [],
      })
      logicalSessionId ||= result.observation.logicalSessionId
    }

    await addUser('应用注入一', 'application', 'system-injection')
    await addUser('应用注入二', 'application', 'system-injection')
    await addUser('真实用户请求', 'human-user', 'user-request')

    for (const materialized of [false, true]) {
      if (materialized) await storage.sessionSummaryProjection.rebuild()
      const projection = new ReviewProjection(storage)
      const detail = await projection.get(logicalSessionId, { direction: 'backward', limit: 3 })
      assert.ok(detail)
      assert.equal(detail.interactionCount, 1)
      assert.deepEqual(detail.interactions.map(item => item.ordinal), [1, 2, 3])

      const latest = await projection.get(logicalSessionId, { filter: 'latest' })
      assert.ok(latest)
      assert.deepEqual(latest.interactions.map(item => item.ordinal), [3])
    }
  } finally {
    await storage.close()
  }
})
