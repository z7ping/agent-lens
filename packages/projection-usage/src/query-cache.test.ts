import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  StorageService,
  ToolUsageAggregateQuery,
  ToolUsageAggregateResult,
  ToolUsageObservationReader,
} from '@agent-lens/core'
import { ToolAssetUsageProjection, usageProjectionInternals } from './index'

function emptyAggregate(): ToolUsageAggregateResult {
  return { tools: [], assets: [], unattributedToolCalls: 0 }
}

test('ToolAssetUsageProjection coalesces 64 identical aggregate reads and reuses the short cache', async () => {
  let aggregateCalls = 0
  let releaseAggregate: (() => void) | undefined
  const blocked = new Promise<void>(resolve => {
    releaseAggregate = () => resolve()
  })
  const reader: ToolUsageObservationReader = {
    async query() {
      throw new Error('raw observation enumeration must not run when aggregate() is available')
    },
    async aggregate() {
      aggregateCalls += 1
      await blocked
      return emptyAggregate()
    },
  }
  const projection = new ToolAssetUsageProjection({ toolUsageObservations: reader } as unknown as StorageService)

  const requests = Array.from({ length: 64 }, () => projection.query({ sourceId: 'codex', limit: 100 }))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(aggregateCalls, 1)

  releaseAggregate?.()
  await Promise.all(requests)
  assert.equal(aggregateCalls, 1)

  await projection.query({ sourceId: 'codex', limit: 10 })
  await projection.queryAssets({ sourceId: 'codex' })
  assert.equal(aggregateCalls, 1, 'presentation limit and queryAssets must reuse the same summary aggregate')

  await projection.query({ sourceId: 'codex', toolName: 'Bash' })
  assert.equal(aggregateCalls, 2, 'a different aggregate query must not reuse another key')
})

test('aggregate cache key follows storage aggregate semantics instead of presentation limit', () => {
  const base: ToolUsageAggregateQuery = {
    sourceId: 'codex',
    projectId: 'project-a',
    detailLimit: usageProjectionInternals.aggregateOverviewDetailLimit,
  }
  assert.equal(
    usageProjectionInternals.aggregateCacheKey(base),
    usageProjectionInternals.aggregateCacheKey({ ...base }),
  )
  assert.notEqual(
    usageProjectionInternals.aggregateCacheKey(base),
    usageProjectionInternals.aggregateCacheKey({ ...base, detailLimit: 5 }),
  )
  assert.equal(usageProjectionInternals.aggregateResultCacheMs, 2_000)
  assert.equal(usageProjectionInternals.aggregateResultCacheMaxEntries, 64)
})
