import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionSummaryQuery, SessionSummaryRecord, StorageService } from '@agent-lens/core'
import { UsageInsightsProjection } from './index'

function session(index: number, projectId: string, toolCount = 0): SessionSummaryRecord {
  const at = `2026-01-${String((index % 28) + 1).padStart(2, '0')}T12:00:00.000Z`
  return {
    logicalSessionId: `session-${projectId}-${index}`,
    installationId: 'installation-1',
    productId: 'codex',
    sourceIds: ['codex'],
    projectId,
    startedAt: at,
    endedAt: at,
    observationCount: toolCount + 1,
    interactionCount: 1,
    toolCount,
    errorCount: 0,
  }
}

test('insights 会先把项目范围下推 Session Summary，而不是从全局最近 500 个会话再筛选', async () => {
  const recentOther = Array.from({ length: 500 }, (_, index) => session(index + 1, 'other-project', 1))
  const target = [session(9001, 'target-project', 3), session(9002, 'target-project', 4)]
  const queries: SessionSummaryQuery[] = []

  const storage = {
    sessionSummaries: {
      query: async (input: SessionSummaryQuery) => {
        queries.push(input)
        if (input.projectId === 'target-project') return { items: target, hasMore: false }
        return { items: recentOther, hasMore: true }
      },
    },
    repositories: {
      observations: {
        query: async () => [],
      },
    },
  } as unknown as StorageService

  const result = await new UsageInsightsProjection(storage).query({ projectId: 'target-project' })

  assert.equal(queries.length, 1)
  assert.equal(queries[0]?.projectId, 'target-project')
  assert.equal(queries[0]?.limit, 500)
  assert.equal(result.summary.sessionCount, 2)
  assert.equal(result.summary.interactionCount, 2)
  assert.equal(result.summary.toolCallCount, 7)
  assert.equal(result.agents[0]?.sourceId, 'codex')
  assert.equal(result.agents[0]?.sessionCount, 2)
  assert.equal(result.meta.sampled, false)
})
