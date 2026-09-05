import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionSummaryQuery, SessionSummaryRecord, StorageService } from '@agent-lens/core'
import { FacetProjection } from './index'

function session(index: number, projectId: string, startedAt: string, endedAt = startedAt): SessionSummaryRecord {
  return {
    logicalSessionId: `session-${index}`,
    installationId: 'installation-1',
    productId: 'codex',
    sourceIds: ['codex'],
    projectId,
    startedAt,
    endedAt,
    observationCount: 1,
    interactionCount: 1,
    toolCount: 0,
    errorCount: 0,
  }
}

test('facet 会分页读取 Session Summary，不会漏掉第 500 条之后的项目和最早日期', async () => {
  const firstPage = Array.from({ length: 500 }, (_, index) => session(
    index + 1,
    'project-recent',
    `2026-09-01T${String(Math.floor(index / 60) % 24).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
  ))
  const old = session(501, 'project-old', '2025-01-02T03:04:05.000Z')
  const queries: SessionSummaryQuery[] = []

  const storage = {
    sessionSummaries: {
      query: async (input: SessionSummaryQuery) => {
        queries.push(input)
        return input.after
          ? { items: [old], hasMore: false }
          : { items: firstPage, hasMore: true }
      },
    },
    repositories: {
      sessions: {
        getProject: async (id: string) => ({
          id,
          name: id === 'project-old' ? '旧项目' : '近期项目',
          repositoryIdentity: `repo:${id}`,
        }),
      },
    },
  } as unknown as StorageService

  const result = await new FacetProjection(storage).query()

  assert.equal(queries.length, 2)
  assert.equal(queries[0]?.limit, 500)
  assert.deepEqual(queries[1]?.after, {
    activeAt: firstPage.at(-1)?.endedAt,
    logicalSessionId: firstPage.at(-1)?.logicalSessionId,
  })
  assert.deepEqual(result.projects.map(item => item.id).sort(), ['project-old', 'project-recent'])
  assert.equal(result.dateRange.from, '2025-01-02T03:04:05.000Z')
  assert.ok(result.dateRange.to?.startsWith('2026-09-01T'))
})
