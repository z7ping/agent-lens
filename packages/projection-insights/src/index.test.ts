import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { UsageInsightsProjection } from './index'

const FROM = '2026-08-01T00:00:00.000Z'
const TO = '2026-08-31T23:59:59.999Z'

function at(day: number, minute: number): string {
  return `2026-08-${String(day).padStart(2, '0')}T12:${String(minute).padStart(2, '0')}:00.000Z`
}

test('usage insights aggregates factual trends, assets and repeated tool sequences', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const identity = new DefaultIdentityService(storage)
  const observations = new DefaultObservationService(storage, identity)
  const host = await identity.resolveHost({ name: 'insights-test-host' })
  const installation = await identity.resolveInstallation({
    hostId: host.id,
    productId: 'codex',
  })

  for (let index = 0; index < 5; index += 1) {
    const day = index + 10
    const sessionId = `insights-session-${index + 1}`
    const baseIdentity = { nativeSessionId: sessionId }
    const commit = async (
      nativeEventId: string,
      kind: 'message.user' | 'tool.call' | 'tool.result',
      occurredAt: string,
      payload: unknown,
    ) => observations.commit({
      sourceId: 'codex',
      host,
      installation,
      candidate: {
        kind,
        nativeEventId,
        occurredAt,
        capturedAt: occurredAt,
        payload,
        identityHints: baseIdentity,
        dedupHints: { nativeEventId },
      },
      evidenceCandidates: [{
        captureMethod: 'native-log',
        derivation: 'reported',
        nativeStableId: nativeEventId,
        eventTime: occurredAt,
        capturedAt: occurredAt,
        confidenceHint: 'exact',
      }],
    })

    await commit(`${sessionId}:user`, 'message.user', at(day, 0), { text: 'analyze repository' })
    await commit(`${sessionId}:read`, 'tool.call', at(day, 1), {
      callId: `${sessionId}:read`,
      nativeToolName: 'read_file',
      input: { path: 'README.md' },
    })
    await commit(`${sessionId}:read-result`, 'tool.result', at(day, 2), {
      callId: `${sessionId}:read`,
      nativeToolName: 'read_file',
      success: true,
      durationMs: 30,
    })
    await commit(`${sessionId}:mcp`, 'tool.call', at(day, 3), {
      callId: `${sessionId}:mcp`,
      nativeToolName: 'mcp__github__search',
      input: { query: 'AgentLens' },
    })
    await commit(`${sessionId}:mcp-result`, 'tool.result', at(day, 4), {
      callId: `${sessionId}:mcp`,
      nativeToolName: 'mcp__github__search',
      success: true,
      durationMs: 40,
    })
    await commit(`${sessionId}:run`, 'tool.call', at(day, 5), {
      callId: `${sessionId}:run`,
      nativeToolName: 'bash_run',
      input: { command: 'npm test' },
    })
    await commit(`${sessionId}:run-result`, 'tool.result', at(day, 6), {
      callId: `${sessionId}:run`,
      nativeToolName: 'bash_run',
      success: index !== 4,
      durationMs: 50,
    })
  }

  const result = await new UsageInsightsProjection(storage).query({ from: FROM, to: TO })

  assert.equal(result.summary.sessionCount, 5)
  assert.equal(result.summary.interactionCount, 5)
  assert.equal(result.summary.toolCallCount, 15)
  assert.equal(result.summary.errorCount, 1)
  assert.equal(result.agents.length, 1)
  assert.equal(result.agents[0]?.sourceId, 'codex')
  assert.equal(result.agents[0]?.sessionCount, 5)

  const githubAsset = result.assets.find(item => item.type === 'mcp' && item.canonicalName === 'github')
  assert.ok(githubAsset)
  assert.equal(githubAsset.callCount, 5)
  assert.equal(githubAsset.attribution, 'derived')

  const pattern = result.workflowPatterns.find(item => item.steps.join('|') === '读取文件|MCP：github|命令执行')
  assert.ok(pattern)
  assert.equal(pattern.sessionCount, 5)
  assert.equal(pattern.occurrenceCount, 5)
  assert.ok(pattern.observationIds.length >= 3)

  assert.ok(result.comparison)
  assert.equal(result.comparison.current.sessionCount, 5)
  assert.equal(result.comparison.previous.sessionCount, 0)
  assert.equal(result.comparison.delta.sessionCountPercent, null)
  assert.equal(result.meta.workflowPatternMinimumSessions, 5)
  assert.equal(result.meta.sampled, false)

  storage.close()
})
