import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionSummaryRecord, StorageService } from '@agent-lens/core'
import { UsageInsightsProjection } from './index'

function session(index: number): SessionSummaryRecord {
  return {
    logicalSessionId: `session-${index}`,
    installationId: 'installation-1',
    productId: 'codex',
    sourceIds: ['codex'],
    startedAt: `2026-09-0${index}T10:00:00.000Z`,
    endedAt: `2026-09-0${index}T10:05:00.000Z`,
    observationCount: 4,
    interactionCount: 1,
    toolCount: 3,
    errorCount: 0,
  }
}

test('Insights 在 Tool Fact 完整时只读取工作流摘要，不扫描 Canonical tool.call', async () => {
  let workflowReads = 0
  let canonicalReads = 0
  const sessions = [1, 2, 3, 4, 5].map(session)
  const storage = {
    sessionSummaries: {
      async query() { return { items: sessions, hasMore: false } },
    },
    toolUsageObservations: {
      async query() { throw new Error('unexpected Tool Usage row scan') },
      async aggregate() { return { tools: [], assets: [], unattributedToolCalls: 0 } },
      async workflowPatterns() {
        workflowReads += 1
        return [{
          key: '读取文件 → 命令执行',
          steps: ['读取文件', '命令执行'],
          sessionCount: 5,
          occurrenceCount: 5,
          sampleSessionIds: sessions.map(item => item.logicalSessionId),
          observationIds: ['observation-1', 'observation-2'],
        }]
      },
    },
    projectionBackfill: {
      async toolUsageFactCoverage() {
        return {
          sourceObservationCount: 30,
          projectedCount: 30,
          missingCount: 0,
          coverageRatio: 1,
          ready: true,
        }
      },
    },
    repositories: {
      observations: {
        async query() {
          canonicalReads += 1
          throw new Error('Insights must not scan Canonical tool.call on the ready fast path')
        },
      },
    },
  } as unknown as StorageService

  const result = await new UsageInsightsProjection(storage).query({})

  assert.equal(workflowReads, 1)
  assert.equal(canonicalReads, 0)
  assert.deepEqual(result.workflowPatterns, [{
    key: '读取文件 → 命令执行',
    steps: ['读取文件', '命令执行'],
    sessionCount: 5,
    occurrenceCount: 5,
    sampleSessionIds: sessions.map(item => item.logicalSessionId),
    observationIds: ['observation-1', 'observation-2'],
    derivation: 'deterministic-sequence',
  }])
})
