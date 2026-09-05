import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DefaultIdentityService,
  DefaultObservationService,
} from '@agent-lens/core-services'
import type { CanonicalObservation, StorageService } from '@agent-lens/core'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { ToolAssetUsageProjection, usageProjectionInternals } from './index'

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

test('ToolAssetUsageProjection paginates beyond the repository row limit', async () => {
  const calls: CanonicalObservation[] = Array.from({ length: 5_001 }, (_, index) => {
    const at = new Date(Date.UTC(2026, 7, 20, 12, 0, 0, index)).toISOString()
    const id = `tool-call-${String(index).padStart(5, '0')}`
    return {
      id,
      hostId: 'host',
      installationId: 'installation',
      logicalSessionId: 'session',
      sourceSessionId: 'source-session',
      kind: 'tool.call',
      canonicalSequence: index,
      occurredAt: at,
      capturedAt: at,
      payload: {
        callId: id,
        nativeToolName: 'Bash',
      },
      evidenceRefs: [],
    }
  })
  const storage = {
    repositories: {
      observations: {
        async query(query: { kind?: string; after?: { id: string }; limit?: number }) {
          if (query.kind !== 'tool.call') return []
          const start = query.after
            ? calls.findIndex(item => item.id === query.after!.id) + 1
            : 0
          return calls.slice(start, start + (query.limit ?? 500))
        },
      },
      sessions: {
        async getSourceSession() {
          return {
            id: 'source-session',
            sourceId: 'codex',
            installationId: 'installation',
            logicalSessionId: 'session',
            nativeSessionId: 'native-session',
            createdAt: '2026-08-20T12:00:00.000Z',
            updatedAt: '2026-08-20T12:00:00.000Z',
          }
        },
      },
      installations: {
        async get() {
          return {
            id: 'installation',
            hostId: 'host',
            productId: 'codex',
            createdAt: '2026-08-20T12:00:00.000Z',
            updatedAt: '2026-08-20T12:00:00.000Z',
          }
        },
      },
    },
  } as unknown as StorageService

  const response = await new ToolAssetUsageProjection(storage).query()

  assert.equal(response.tools.length, 1)
  assert.equal(response.tools[0]?.nativeToolName, 'Bash')
  assert.equal(response.tools[0]?.callCount, 5_001)
  assert.equal(response.tools[0]?.observationIds.length, usageProjectionInternals.maxDetailObservationIds)
  assert.equal(response.meta.unattributedToolCalls, 5_001)
})

test('ToolAssetUsageProjection keeps exact totals while bounding session and observation detail arrays', async () => {
  const calls: CanonicalObservation[] = Array.from({ length: 150 }, (_, index) => {
    const id = `bounded-call-${String(index).padStart(3, '0')}`
    const at = new Date(Date.UTC(2026, 7, 21, 12, 0, index)).toISOString()
    return {
      id,
      hostId: 'host',
      installationId: 'installation',
      logicalSessionId: `session-${String(index).padStart(3, '0')}`,
      sourceSessionId: 'source-session',
      kind: 'tool.call',
      canonicalSequence: index,
      occurredAt: at,
      capturedAt: at,
      payload: {
        callId: id,
        nativeToolName: 'mcp__docs__search',
        input: { query: id },
      },
      evidenceRefs: [],
    }
  })
  const storage = {
    repositories: {
      observations: {
        async query(query: { kind?: string; after?: { id: string }; limit?: number }) {
          if (query.kind !== 'tool.call') return []
          const start = query.after
            ? calls.findIndex(item => item.id === query.after!.id) + 1
            : 0
          return calls.slice(start, start + (query.limit ?? 500))
        },
      },
      sessions: {
        async getSourceSession() {
          return {
            id: 'source-session',
            sourceId: 'codex',
            installationId: 'installation',
            logicalSessionId: 'session',
            nativeSessionId: 'native-session',
            createdAt: '2026-08-21T12:00:00.000Z',
            updatedAt: '2026-08-21T12:00:00.000Z',
          }
        },
      },
      installations: {
        async get() {
          return {
            id: 'installation',
            hostId: 'host',
            productId: 'codex',
            createdAt: '2026-08-21T12:00:00.000Z',
            updatedAt: '2026-08-21T12:00:00.000Z',
          }
        },
      },
    },
  } as unknown as StorageService

  const response = await new ToolAssetUsageProjection(storage).query()
  const tool = response.tools[0]
  const asset = response.assets[0]

  assert.equal(tool?.callCount, 150)
  assert.equal(tool?.sessionCount, 150)
  assert.equal(tool?.sessions.length, usageProjectionInternals.maxDetailSessions)
  assert.equal(tool?.observationIds.length, usageProjectionInternals.maxDetailObservationIds)
  assert.equal(asset?.callCount, 150)
  assert.equal(asset?.observationIds.length, usageProjectionInternals.maxDetailObservationIds)
})
