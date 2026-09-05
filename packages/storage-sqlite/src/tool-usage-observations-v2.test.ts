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

    // 大量同会话调用与失败，覆盖过去逐条关联造成的退化；范围外失败不得混入下钻。
    const insert = storage.db.prepare(`
      INSERT INTO observations (
        id, host_id, installation_id, logical_session_id, source_session_id,
        kind, occurred_at, captured_at, payload_json
      ) SELECT ?, host_id, installation_id, logical_session_id, source_session_id,
        ?, ?, ?, ? FROM observations WHERE id = ?
    `)
    const later = '2026-09-06T01:00:00.000Z'
    storage.db.transaction(() => {
      for (let index = 0; index < 3000; index += 1) {
        const toolName = index % 2 === 0 ? 'Bash' : 'Read'
        const callId = `bulk-${index}`
        insert.run(`bulk-call-${index}`, 'tool.call', later, later,
          JSON.stringify({ call_id: callId, tool_name: toolName }), call.observation.id)
        insert.run(`bulk-result-${index}`, 'tool.result', later, later,
          JSON.stringify({ call_id: callId, success: false }), call.observation.id)
      }
    })()
    const scoped = await storage.toolUsageObservations.aggregate({
      detailLimit: 100,
      from: '2026-09-05T00:00:00.000Z',
      to: '2026-09-05T23:59:59.999Z',
    })
    assert.equal(scoped.tools.length, 1)
    assert.equal(scoped.tools[0]?.sessions[0]?.errorCount, 1)
    const bulk = await storage.toolUsageObservations.aggregate({ detailLimit: 100, from: later })
    for (const name of ['Bash', 'Read']) {
      const tool = bulk.tools.find(item => item.nativeToolName === name)
      assert.equal(tool?.callCount, 1500)
      assert.equal(tool?.errorCount, 1500)
      assert.equal(tool?.sessions[0]?.errorCount, 1500)
    }

  } finally {
    await storage.close()
  }
})
