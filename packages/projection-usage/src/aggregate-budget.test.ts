import assert from 'node:assert/strict'
import test from 'node:test'
import type { StorageService, ToolUsageAggregateQuery } from '@agent-lens/core'
import { ToolAssetUsageProjection, usageProjectionInternals } from './index'

function storageWithAggregate(calls: ToolUsageAggregateQuery[]): StorageService {
  return {
    toolUsageObservations: {
      async query() { return [] },
      async aggregate(input: ToolUsageAggregateQuery) {
        calls.push(input)
        return { tools: [], assets: [], unattributedToolCalls: 0 }
      },
    },
  } as unknown as StorageService
}

test('tool overview requests summary-only aggregate', async () => {
  const calls: ToolUsageAggregateQuery[] = []
  await new ToolAssetUsageProjection(storageWithAggregate(calls)).query({ sourceId: 'codex' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.detailLimit, 0)
  assert.equal(usageProjectionInternals.aggregateOverviewDetailLimit, 0)
})

test('tool detail keeps the bounded session detail budget', async () => {
  const calls: ToolUsageAggregateQuery[] = []
  await new ToolAssetUsageProjection(storageWithAggregate(calls)).query({ sourceId: 'codex' }, 5)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.detailLimit, 5)
  assert.equal(usageProjectionInternals.aggregateDetailLimit, 5)
})

test('agent asset usage requests summary-only aggregate', async () => {
  const calls: ToolUsageAggregateQuery[] = []
  await new ToolAssetUsageProjection(storageWithAggregate(calls)).queryAssets({ sourceId: 'codex' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.detailLimit, 0)
  assert.equal(usageProjectionInternals.aggregateAssetDetailLimit, 0)
})
