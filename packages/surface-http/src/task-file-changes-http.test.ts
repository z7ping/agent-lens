import assert from 'node:assert/strict'
import test from 'node:test'
import { observedSessionFileChanges, taskFileChangesResponse } from './task-file-changes-http'
import type { CanonicalObservation, ObservationQuery, StorageService } from '@agent-lens/core'

test('旧会话从有界 Canonical 文件事件恢复摘要，保留截断信号', async () => {
  let query: ObservationQuery | undefined
  const event: CanonicalObservation = { id: 'artifact', hostId: 'host', installationId: 'installation',
    logicalSessionId: 'session', sourceSessionId: 'source', kind: 'artifact.action',
    capturedAt: '2026-10-16T00:00:00Z', evidenceRefs: [],
    payload: { action: 'file.change', status: 'completed', changes: { 'a.ts': { type: 'update' } } } }
  const storage = { repositories: { observations: { query: async (input: ObservationQuery) => {
    query = input
    return Array.from({ length: 5001 }, (_, index) => ({ ...event, id: `artifact-${index}` }))
  } } } } as unknown as StorageService
  const result = await observedSessionFileChanges(storage, 'session')
  assert.equal(query?.kind, 'artifact.action')
  assert.equal(query?.limit, 5001)
  assert.deepEqual(query?.logicalSessionIds, ['session'])
  assert.equal(result.truncated, true)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.confidence, 'medium')
})

test('session-level exact Git counts remain distinct from per-round observed changes', () => {
  const final = taskFileChangesResponse('session-1', [{
    logicalSessionId: 'session-1',
    path: 'src/a.ts',
    changeType: 'modified',
    additions: 7,
    deletions: 2,
    firstChangedAt: '2026-10-16T00:00:00Z',
    lastChangedAt: '2026-10-16T00:02:00Z',
    evidence: ['git'],
    confidence: 'exact',
  }], { workspacePath: '/repo', gitRootPath: '/repo' })
  assert.equal(final.summary.additions, 7)
  assert.equal(final.summary.deletions, 2)
  assert.equal(final.summary.exactCount, 1)

  const round = taskFileChangesResponse('session-1', [{
    logicalSessionId: 'session-1',
    path: 'src/a.ts',
    changeType: 'unknown',
    firstChangedAt: '2026-10-16T00:00:10Z',
    lastChangedAt: '2026-10-16T00:00:10Z',
    evidence: ['tool'],
    confidence: 'medium',
  }], null, { interactionId: 'turn-1', truncated: true })
  assert.equal(round.interactionId, 'turn-1')
  assert.equal(round.summary.additions, undefined)
  assert.equal(round.summary.deletions, undefined)
  assert.equal(round.summary.exactCount, 0)
  assert.equal(round.summary.observedCount, 1)
  assert.equal(round.meta.truncated, true)
})
