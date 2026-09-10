import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceService, StorageService, ToolUsageAggregateQuery } from '@agent-lens/core'
import { AgentOverviewProjection, FacetProjection } from './index'

test('facets uses one materialized facetScope call instead of paging all sessions', async () => {
  let facetCalls = 0
  const storage = {
    sessionSummaryProjection: {
      async facetScope() {
        facetCalls += 1
        return {
          projects: [{ id: 'project-1', name: 'AgentLens' }],
          from: '2026-09-01T00:00:00.000Z',
          to: '2026-09-06T00:00:00.000Z',
        }
      },
    },
    sessionSummaries: {
      async query() { throw new Error('foreground facets must not page session summaries') },
    },
  } as unknown as StorageService

  const result = await new FacetProjection(storage).query()
  assert.equal(facetCalls, 1)
  assert.equal(result.projects.length, 1)
  assert.equal(result.projects[0]?.id, 'project-1')
})

test('Agent Overview aggregates tool assets once per source, not once per installation', async () => {
  const aggregateCalls: ToolUsageAggregateQuery[] = []
  const storage = {
    repositories: {
      installations: {
        async listByProduct() {
          return [
            { id: 'install-a', productId: 'codex', firstSeenAt: '2026-09-01T00:00:00.000Z', lastSeenAt: '2026-09-06T00:00:00.000Z' },
            { id: 'install-b', productId: 'codex', firstSeenAt: '2026-09-02T00:00:00.000Z', lastSeenAt: '2026-09-06T00:00:00.000Z' },
          ]
        },
      },
    },
    toolUsageObservations: {
      async query() { return [] },
      async aggregate(input: ToolUsageAggregateQuery) {
        aggregateCalls.push(input)
        return {
          tools: [],
          assets: [{
            type: 'mcp' as const,
            canonicalName: 'github',
            sourceIds: ['codex'],
            callCount: 10,
            firstUsedAt: '2026-09-01T00:00:00.000Z',
            lastUsedAt: '2026-09-06T00:00:00.000Z',
            observationIds: [],
          }],
          unattributedToolCalls: 0,
        }
      },
    },
    assetInventory: {
      async listByInstallation() { return [] },
    },
  } as unknown as StorageService
  const sources = {
    list() {
      return [{ manifest: { sourceId: 'codex', productId: 'codex', displayName: 'Codex' } }]
    },
  } as unknown as SourceService

  const result = await new AgentOverviewProjection(storage, sources).query()
  assert.equal(aggregateCalls.length, 1)
  assert.deepEqual(aggregateCalls[0]?.sourceIds, ['codex'])
  assert.equal(aggregateCalls[0]?.detailLimit, 0)
  assert.equal(result.items[0]?.usedAssets[0]?.callCount, 10)
})

test('Agent Overview uses one exact source-partitioned asset aggregate when storage provides it', async () => {
  let aggregateCalls = 0
  let sourceAggregateCalls = 0
  const storage = {
    repositories: { installations: { async listByProduct() { return [] } } },
    toolUsageObservations: {
      async query() { return [] },
      async aggregate() { aggregateCalls += 1; return { tools: [], assets: [], unattributedToolCalls: 0 } },
      async aggregateAssetsBySource() {
        sourceAggregateCalls += 1
        return [{ type: 'mcp' as const, canonicalName: 'github', sourceIds: ['codex'], callCount: 7,
          firstUsedAt: '2026-09-01T00:00:00.000Z', lastUsedAt: '2026-09-06T00:00:00.000Z', observationIds: [] }]
      },
    },
  } as unknown as StorageService
  const sources = { list() { return [
    { manifest: { sourceId: 'codex', productId: 'codex', displayName: 'Codex' } },
    { manifest: { sourceId: 'claude', productId: 'claude', displayName: 'Claude' } },
  ] } } as unknown as SourceService

  const result = await new AgentOverviewProjection(storage, sources).query()
  assert.equal(sourceAggregateCalls, 1)
  assert.equal(aggregateCalls, 0)
  assert.equal(result.items.find(item => item.sourceId === 'codex')?.usedAssets[0]?.callCount, 7)
  assert.equal(result.items.find(item => item.sourceId === 'claude')?.usedAssets.length, 0)
})
