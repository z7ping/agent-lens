import assert from 'node:assert/strict'
import test from 'node:test'
import { taskFileChangesResponse } from './task-file-changes-http'

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
