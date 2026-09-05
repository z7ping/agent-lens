import assert from 'node:assert/strict'
import test from 'node:test'
import type { StorageService, ToolUsageObservationReader } from '@agent-lens/core'
import { ToolAssetUsageProjection, usageProjectionInternals } from './index'

test('ToolAssetUsageProjection prefers storage-side aggregate without enumerating raw observations', async () => {
  let aggregateCalls = 0
  const observationIds = Array.from(
    { length: usageProjectionInternals.maxDetailObservationIds },
    (_, index) => `observation-${index}`,
  )
  const reader: ToolUsageObservationReader = {
    async query() {
      throw new Error('raw observation enumeration must not run when aggregate() is available')
    },
    async aggregate(input) {
      aggregateCalls += 1
      assert.equal(input.sourceId, 'codex')
      assert.equal(input.detailLimit, usageProjectionInternals.maxDetailObservationIds)
      return {
        tools: [{
          nativeToolName: 'mcp__docs__search',
          sourceIds: ['codex'],
          productIds: ['codex'],
          callCount: 10_000,
          resultCount: 10_000,
          successCount: 9_999,
          errorCount: 1,
          sessionCount: 2_000,
          sessions: [{ logicalSessionId: 'session-a', callCount: 8 }],
          totalDurationMs: 50_000,
          firstUsedAt: '2026-08-01T00:00:00.000Z',
          lastUsedAt: '2026-09-01T00:00:00.000Z',
          observationIds,
        }],
        assets: [{
          type: 'mcp',
          canonicalName: 'docs',
          sourceIds: ['codex'],
          callCount: 10_000,
          firstUsedAt: '2026-08-01T00:00:00.000Z',
          lastUsedAt: '2026-09-01T00:00:00.000Z',
          observationIds,
        }],
        unattributedToolCalls: 0,
      }
    },
  }
  const storage = { toolUsageObservations: reader } as unknown as StorageService
  const projection = new ToolAssetUsageProjection(storage)

  const response = await projection.query({ sourceId: 'codex' })
  assert.equal(aggregateCalls, 1)
  assert.equal(response.tools[0]?.callCount, 10_000)
  assert.equal(response.tools[0]?.sessionCount, 2_000)
  assert.equal(response.tools[0]?.observationIds.length, usageProjectionInternals.maxDetailObservationIds)
  assert.equal(response.assets[0]?.callCount, 10_000)

  const assets = await projection.queryAssets({ sourceId: 'codex' })
  assert.equal(aggregateCalls, 2)
  assert.equal(assets[0]?.canonicalName, 'docs')
})
