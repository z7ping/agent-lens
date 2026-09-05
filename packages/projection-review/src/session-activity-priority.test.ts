import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewProjectionInternals } from './index'

const { resolveSessionActivity } = reviewProjectionInternals

test('real user turns override generic system activity', () => {
  assert.equal(resolveSessionActivity('system-activity', 1, 3), 'user-task')
  assert.equal(resolveSessionActivity(undefined, 2, 0), 'user-task')
})

test('strong internal session identities are not overwritten by user-looking content', () => {
  assert.equal(resolveSessionActivity('branch-task', 1, 0), 'branch-task')
  assert.equal(resolveSessionActivity('subagent', 1, 0), 'subagent')
  assert.equal(resolveSessionActivity('internal-review', 1, 0), 'internal-review')
})

test('system-only context remains system activity without a real user turn', () => {
  assert.equal(resolveSessionActivity('user-task', 0, 2), 'system-activity')
  assert.equal(resolveSessionActivity('system-activity', 0, 0), 'system-activity')
})
