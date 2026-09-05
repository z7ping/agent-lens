import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionSummaryV2Internals } from './session-summaries-v2'

const { correctedSessionActivity } = sessionSummaryV2Internals

test('Codex real user turn overrides generic system activity', () => {
  assert.equal(correctedSessionActivity('system-activity', 1), 'user-task')
  assert.equal(correctedSessionActivity('user-task', 1), 'user-task')
})

test('strong structural child activities are not overwritten by user-like inherited context', () => {
  assert.equal(correctedSessionActivity('branch-task', 1), 'branch-task')
  assert.equal(correctedSessionActivity('subagent', 1), 'subagent')
  assert.equal(correctedSessionActivity('internal-review', 1), 'internal-review')
})

test('Codex session without authoritative user turn remains system activity', () => {
  assert.equal(correctedSessionActivity('system-activity', 0), 'system-activity')
  assert.equal(correctedSessionActivity('user-task', 0), 'system-activity')
})
