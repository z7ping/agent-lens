import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultIdentityService, DefaultObservationService } from '@agent-lens/core-services'
import { SqliteStorageService } from './storage'

function attachNativeEvidence(storage: SqliteStorageService, observationId: string, installationId: string, nativeType: string, suffix: string, nativeSessionId = 'legacy-codex-session'): void {
  const capturedAt = '2026-09-05T00:00:00.000Z'
  storage.db.prepare(`
    INSERT INTO source_records(
      id, source_id, installation_id, source_session_native_id, native_type,
      captured_at, locator_json, payload_json, parser_version
    ) VALUES (?, 'codex', ?, ?, ?, ?, '{}', '{}', 'legacy')
  `).run(`source-${suffix}`, installationId, nativeSessionId, nativeType, capturedAt)
  storage.db.prepare(`
    INSERT INTO evidence(id, capture_method, derivation, confidence, source_record_id, captured_at)
    VALUES (?, 'history', 'direct', 'high', ?, ?)
  `).run(`evidence-${suffix}`, `source-${suffix}`, capturedAt)
  storage.db.prepare(`
    INSERT INTO observation_evidence(observation_id, evidence_id) VALUES (?, ?)
  `).run(observationId, `evidence-${suffix}`)
}

test('Codex legacy transport echo cannot become the task title when native evidence identifies the real user event', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'codex-title-provenance-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })

    const polluted = await observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'message.user',
        nativeEventId: 'legacy-echo',
        occurredAt: '2026-09-05T00:00:01.000Z',
        capturedAt: '2026-09-05T00:00:01.000Z',
        payload: { text: '<recommended_plugins>系统注入内容</recommended_plugins>' },
        identityHints: { nativeSessionId: 'legacy-codex-session' },
        dedupHints: { nativeEventId: 'legacy-echo' },
      },
      evidenceCandidates: [],
    })
    const human = await observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'message.user',
        nativeEventId: 'legacy-real-user',
        occurredAt: '2026-09-05T00:00:02.000Z',
        capturedAt: '2026-09-05T00:00:02.000Z',
        payload: { text: '真正的用户任务' },
        identityHints: { nativeSessionId: 'legacy-codex-session' },
        dedupHints: { nativeEventId: 'legacy-real-user' },
      },
      evidenceCandidates: [],
    })

    attachNativeEvidence(storage, polluted.observation.id, installation.id, 'response_item/message', 'echo')
    attachNativeEvidence(storage, human.observation.id, installation.id, 'event_msg/user_message', 'human')

    for (const materialized of [false, true]) {
      if (materialized) await storage.sessionSummaryProjection.rebuild()
      const page = await storage.sessionSummaries.query({ logicalSessionId: human.observation.logicalSessionId, limit: 1 })
      const summary = page.items[0]
      assert.ok(summary)
      assert.equal(summary.userTurnCount, 1)
      assert.equal(summary.interactionCount, 1)
      assert.equal((summary.firstUserPayload as any)?.text, '真正的用户任务')
      assert.equal(summary.title, '真正的用户任务')
      assert.equal(summary.sessionActivity, 'user-task')
    }
  } finally {
    await storage.close()
  }
})

test('Codex legacy session with transport echo only is corrected to system activity', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'codex-system-only-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    const echoed = await observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'message.user',
        nativeEventId: 'system-only-echo',
        occurredAt: '2026-09-05T00:01:00.000Z',
        capturedAt: '2026-09-05T00:01:00.000Z',
        payload: { text: '<recommended_plugins>仅系统注入</recommended_plugins>' },
        identityHints: { nativeSessionId: 'system-only-session' },
        dedupHints: { nativeEventId: 'system-only-echo' },
      },
      evidenceCandidates: [],
    })
    attachNativeEvidence(storage, echoed.observation.id, installation.id, 'response_item/message', 'system-only', 'system-only-session')

    const page = await storage.sessionSummaries.query({ logicalSessionId: echoed.observation.logicalSessionId, limit: 1 })
    assert.equal(page.items[0]?.userTurnCount, 0)
    assert.equal(page.items[0]?.interactionCount, 0)
    assert.equal(page.items[0]?.firstUserPayload, undefined)
    assert.equal(page.items[0]?.sessionActivity, 'system-activity')
  } finally {
    await storage.close()
  }
})

test('non-Codex legacy user messages without provenance remain compatible', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'legacy-source-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'claude-code' })
    const committed = await observations.commit({
      sourceId: 'claude-code',
      host,
      installation,
      candidate: {
        kind: 'message.user',
        nativeEventId: 'legacy-user',
        occurredAt: '2026-09-05T00:00:03.000Z',
        capturedAt: '2026-09-05T00:00:03.000Z',
        payload: { text: '旧版真实用户请求' },
        identityHints: { nativeSessionId: 'legacy-claude-session' },
        dedupHints: { nativeEventId: 'legacy-user' },
      },
      evidenceCandidates: [],
    })

    const page = await storage.sessionSummaries.query({ logicalSessionId: committed.observation.logicalSessionId, limit: 1 })
    assert.equal(page.items[0]?.userTurnCount, 1)
    assert.equal((page.items[0]?.firstUserPayload as any)?.text, '旧版真实用户请求')
  } finally {
    await storage.close()
  }
})
