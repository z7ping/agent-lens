import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultIdentityService, DefaultObservationService } from '@agent-lens/core-services'
import { SqliteStorageService } from './storage'
import { toolUsageFactInternals } from './tool-usage-facts'

test('工具事实投影提取高频字段并驱动聚合', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'tool-fact-host' })
    const installation = await identity.resolveInstallation({ hostId: host.id, productId: 'codex' })
    const nativeSessionId = 'tool-fact-session'

    const call = await observations.commit({
      sourceId: 'codex', host, installation,
      candidate: {
        kind: 'tool.call', nativeEventId: 'call', nativeCallId: 'c1',
        occurredAt: '2026-09-05T01:00:00.000Z', capturedAt: '2026-09-05T01:00:00.000Z',
        payload: { callId: 'c1', toolName: 'Skill', input: { skill: 'review-code' } },
        identityHints: { nativeSessionId }, dedupHints: { nativeEventId: 'call' },
      },
      evidenceCandidates: [],
    })
    await observations.commit({
      sourceId: 'codex', host, installation,
      candidate: {
        kind: 'tool.result', nativeEventId: 'result', nativeCallId: 'c1',
        occurredAt: '2026-09-05T01:00:01.000Z', capturedAt: '2026-09-05T01:00:01.000Z',
        payload: { call_id: 'c1', success: false, duration_ms: 12 },
        identityHints: { nativeSessionId }, dedupHints: { nativeEventId: 'result' },
      },
      evidenceCandidates: [],
    })
    await observations.commit({
      sourceId: 'codex', host, installation,
      candidate: {
        kind: 'tool.call', nativeEventId: 'bash-call', nativeCallId: 'c2',
        occurredAt: '2026-09-05T01:00:02.000Z', capturedAt: '2026-09-05T01:00:02.000Z',
        payload: { callId: 'c2', toolName: 'Bash', input: { command: 'git status' } },
        identityHints: { nativeSessionId }, dedupHints: { nativeEventId: 'bash-call' },
      },
      evidenceCandidates: [],
    })
    await observations.commit({
      sourceId: 'codex', host, installation,
      candidate: {
        kind: 'tool.result', nativeEventId: 'bash-result', nativeCallId: 'c2',
        occurredAt: '2026-09-05T01:00:03.000Z', capturedAt: '2026-09-05T01:00:03.000Z',
        payload: { call_id: 'c2', success: true, duration_ms: 3 },
        identityHints: { nativeSessionId }, dedupHints: { nativeEventId: 'bash-result' },
      },
      evidenceCandidates: [],
    })

    const fact = storage.db.prepare(`
      SELECT tool_name, call_id, skill_name, success, duration_ms
      FROM tool_usage_fact_projection
      WHERE observation_id = ?
    `).get(call.observation.id) as {
      tool_name: string | null
      call_id: string | null
      skill_name: string | null
      success: number | null
      duration_ms: number | null
    }
    assert.deepEqual(fact, {
      tool_name: 'Skill',
      call_id: 'c1',
      skill_name: 'review-code',
      success: null,
      duration_ms: null,
    })

    const aggregate = await storage.toolUsageObservations.aggregate({ detailLimit: 20 })
    const skillTool = aggregate.tools.find(item => item.nativeToolName === 'Skill')
    assert.equal(skillTool?.callCount, 1)
    assert.equal(skillTool?.resultCount, 1)
    assert.equal(skillTool?.errorCount, 1)
    assert.equal(skillTool?.totalDurationMs, 12)
    assert.equal(skillTool?.sessions.length, 1)
    assert.ok((skillTool?.observationIds.length ?? 0) > 0)
    const skillAsset = aggregate.assets.find(item => item.type === 'skill' && item.canonicalName === 'review-code')
    assert.equal(skillAsset?.callCount, 1)

    const summaryOnly = await storage.toolUsageObservations.aggregate({ detailLimit: 0 })
    const summarySkill = summaryOnly.tools.find(item => item.nativeToolName === 'Skill')
    assert.equal(summarySkill?.callCount, skillTool?.callCount)
    assert.equal(summarySkill?.resultCount, skillTool?.resultCount)
    assert.equal(summarySkill?.errorCount, skillTool?.errorCount)
    assert.equal(summarySkill?.sessionCount, skillTool?.sessionCount)
    assert.deepEqual(summarySkill?.sessions, [])
    assert.deepEqual(summarySkill?.observationIds, [])
    assert.equal(summaryOnly.assets.find(item => item.canonicalName === 'review-code')?.observationIds.length, 0)

    const drilldown = await storage.toolUsageObservations.aggregate({ toolName: 'Skill', detailLimit: 5 })
    assert.deepEqual(drilldown.tools.map(item => item.nativeToolName), ['Skill'])
    assert.equal(drilldown.tools[0]?.callCount, 1)
    assert.equal(drilldown.tools[0]?.resultCount, 1)
    assert.equal(drilldown.tools[0]?.sessions.length, 1)
    assert.equal(drilldown.assets.some(item => item.canonicalName === 'review-code'), true)
  } finally {
    await storage.close()
  }
})

test('工具聚合 CTE 只读取轻量事实表，不再解析 Observation payload_json', () => {
  const sql = toolUsageFactInternals.aggregateCtes(["f.kind IN ('tool.call', 'tool.result')"])
  assert.match(sql, /tool_usage_fact_projection/)
  assert.doesNotMatch(sql, /payload_json/i)
  assert.doesNotMatch(sql, /json_extract/i)
  assert.doesNotMatch(sql, /FROM\s+observations/i)
})

test('工具详情过滤在事实表入口按原生工具名收窄', () => {
  const filter = toolUsageFactInternals.aggregateFilter({ sourceId: 'codex', toolName: 'Skill', detailLimit: 5 })
  assert.equal(filter.conditions.includes('f.source_id = ?'), true)
  assert.equal(filter.conditions.includes('f.tool_name = ?'), true)
  assert.deepEqual(filter.params, ['codex', 'Skill'])
})
