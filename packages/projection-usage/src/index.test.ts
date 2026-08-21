import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { ToolAssetUsageProjection } from './index'

test('ToolAssetUsageProjection attributes only defensible MCP and Skill usage', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  try {
    const identity = new DefaultIdentityService(storage)
    const observations = new DefaultObservationService(storage, identity)
    const host = await identity.resolveHost({ name: 'usage-projection-host' })
    const installation = await identity.resolveInstallation({
      hostId: host.id,
      productId: 'claude-code',
    })

    const commit = async (
      kind: 'tool.call' | 'tool.result',
      nativeCallId: string,
      at: string,
      payload: unknown,
    ) => observations.commit({
      sourceId: 'claude-code',
      host,
      installation,
      candidate: {
        kind,
        nativeCallId,
        occurredAt: at,
        capturedAt: at,
        payload,
        identityHints: { nativeSessionId: 'usage-session' },
        dedupHints: { nativeCallId },
      },
      evidenceCandidates: [{
        captureMethod: 'native-log',
        derivation: 'reported',
        nativeStableId: `${kind}:${nativeCallId}`,
        capturedAt: at,
      }],
    })

    await commit('tool.call', 'mcp-call', '2026-08-20T12:00:00.000Z', {
      callId: 'mcp-call',
      nativeToolName: 'mcp__docs__search',
      input: { query: 'AgentLens' },
    })
    await commit('tool.result', 'mcp-call', '2026-08-20T12:00:01.000Z', {
      callId: 'mcp-call',
      success: true,
      durationMs: 120,
    })
    await commit('tool.call', 'skill-call', '2026-08-20T12:00:02.000Z', {
      callId: 'skill-call',
      nativeToolName: 'Skill',
      input: { skill: 'reviewer' },
    })
    await commit('tool.result', 'skill-call', '2026-08-20T12:00:03.000Z', {
      callId: 'skill-call',
      success: false,
      durationMs: 30,
    })
    await commit('tool.call', 'bash-call', '2026-08-20T12:00:04.000Z', {
      callId: 'bash-call',
      nativeToolName: 'Bash',
      input: { command: 'git status' },
    })
    await commit('tool.result', 'bash-call', '2026-08-20T12:00:05.000Z', {
      callId: 'bash-call',
      success: true,
      durationMs: 50,
    })

    const projection = new ToolAssetUsageProjection(storage)
    const response = await projection.query({ installationId: installation.id })
    assert.equal(response.tools.length, 3)
    assert.equal(response.assets.length, 2)
    assert.equal(response.meta.unattributedToolCalls, 1)

    const mcpTool = response.tools.find(item => item.nativeToolName === 'mcp__docs__search')
    assert.equal(mcpTool?.callCount, 1)
    assert.equal(mcpTool?.resultCount, 1)
    assert.equal(mcpTool?.successCount, 1)
    assert.equal(mcpTool?.totalDurationMs, 120)

    const skillTool = response.tools.find(item => item.nativeToolName === 'Skill')
    assert.equal(skillTool?.errorCount, 1)
    assert.equal(skillTool?.totalDurationMs, 30)

    assert.deepEqual(
      response.assets.map(item => `${item.type}:${item.canonicalName}`).sort(),
      ['mcp:docs', 'skill:reviewer'],
    )
    assert.equal(response.assets.every(item => item.attribution === 'derived'), true)
    assert.equal(response.assets.every(item => item.confidence === 'high'), true)
    assert.equal(response.assets.some(item => item.canonicalName === 'Bash'), false)
  } finally {
    storage.close()
  }
})
