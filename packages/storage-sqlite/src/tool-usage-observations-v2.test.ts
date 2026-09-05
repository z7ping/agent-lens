import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultIdentityService, DefaultObservationService } from '@agent-lens/core-services'
import { SqliteStorageService } from './storage'

test('tool usage aggregate enriches sampled sessions with title, time and tool-specific failures', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()

  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'usage-detail-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    const nativeSessionId = 'usage-detail-session'

    const call = await observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'tool.call',
        nativeEventId: 'usage-detail-call',
        nativeCallId: 'call-1',
        occurredAt: '2026-09-05T01:00:00.000Z',
        capturedAt: '2026-09-05T01:00:00.000Z',
        payload: { callId: 'call-1', nativeToolName: 'Bash', input: { command: 'exit 1' } },
        identityHints: { nativeSessionId },
        dedupHints: { nativeEventId: 'usage-detail-call' },
      },
      evidenceCandidates: [],
    })
    await observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind: 'tool.result',
        nativeEventId: 'usage-detail-result',
        nativeCallId: 'call-1',
        occurredAt: '2026-09-05T01:00:01.000Z',
        capturedAt: '2026-09-05T01:00:01.000Z',
        payload: { callId: 'call-1', success: false, durationMs: 50 },
        identityHints: { nativeSessionId },
        dedupHints: { nativeEventId: 'usage-detail-result' },
      },
      evidenceCandidates: [],
    })

    storage.db.prepare(`
      UPDATE logical_sessions
      SET title = ?, ended_at = ?
      WHERE id = ?
    `).run('修复登录失败任务', '2026-09-05T01:00:01.000Z', call.observation.logicalSessionId)

    const aggregate = await storage.toolUsageObservations.aggregate({
      installationId: installation.id,
      detailLimit: 100,
    })
    const bash = aggregate.tools.find(tool => tool.nativeToolName === 'Bash')
    assert.ok(bash)
    assert.equal(bash.errorCount, 1)
    assert.equal(bash.sessions.length, 1)
    assert.equal(bash.sessions[0]?.logicalSessionId, call.observation.logicalSessionId)
    assert.equal(bash.sessions[0]?.errorCount, 1)
    assert.equal(bash.sessions[0]?.title, '修复登录失败任务')
    assert.equal(bash.sessions[0]?.endedAt, '2026-09-05T01:00:01.000Z')
  } finally {
    await storage.close()
  }
})
