import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyReplicationFieldPolicy,
  authorizeHistory,
  decideHistoryScopeTransition,
  decideReplicationPolicyTransition,
  transformReplicationEntity,
  type HistoryBoundary,
  type ReplicationPolicy,
} from './index'

const metadataOnly: ReplicationPolicy = { mode: 'metadata-only', revision: 'p1' }
const redacted: ReplicationPolicy = { mode: 'redacted', revision: 'p2' }
const full: ReplicationPolicy = { mode: 'full', revision: 'p3' }
const includeExisting: HistoryBoundary = { mode: 'include-existing', revision: 'h1' }
const fromNow: HistoryBoundary = {
  mode: 'from-now',
  revision: 'h2',
  boundaryCapturedAt: '2026-08-28T00:00:00Z',
}

test('metadata-only omits content and paths but keeps structural metadata', () => {
  const result = transformReplicationEntity({
    entityType: 'LogicalSession',
    body: { title: 'secret task', startedAt: '2026-08-28T00:01:00Z', installationId: 'install-1' },
    capturedAt: '2026-08-28T00:01:00Z',
    phase: 'incremental',
    policy: metadataOnly,
    history: includeExisting,
  })
  assert.deepEqual(result.body.title, { state: 'omitted', reason: 'policy' })
  assert.deepEqual(result.body.startedAt, { state: 'value', value: '2026-08-28T00:01:00Z' })
  assert.deepEqual(result.body.installationId, { state: 'value', value: 'install-1' })
})

test('capture state is monotonic and cannot be restored by replication policy', () => {
  assert.deepEqual(
    applyReplicationFieldPolicy({ value: 'original', fieldClass: 'content', policy: full, captureState: 'not-captured' }),
    { state: 'omitted', reason: 'not-captured' },
  )
  assert.deepEqual(
    applyReplicationFieldPolicy({ value: 'original', fieldClass: 'content', policy: full, captureState: 'redacted' }),
    { state: 'redacted' },
  )
})

test('full still redacts recognized credentials', () => {
  const result = applyReplicationFieldPolicy({
    value: { token: 'plain-secret', command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"' },
    fieldClass: 'content',
    policy: full,
  })
  assert.deepEqual(result, {
    state: 'value',
    value: { token: '[REDACTED]', command: 'curl -H "Authorization: [REDACTED]"' },
  })
})

test('from-now blocks old history in bootstrap and reconciliation alike', () => {
  for (const phase of ['bootstrap', 'reconcile'] as const) {
    assert.deepEqual(
      authorizeHistory({ boundary: fromNow, entityCapturedAt: '2026-08-27T23:00:00Z', phase }),
      { kind: 'blocked', reason: 'history-boundary' },
    )
  }
})

test('old dependencies only expose registered minimum dependency fields', () => {
  const result = transformReplicationEntity({
    entityType: 'Project',
    body: {
      name: 'AgentLens private title',
      repositoryIdentity: 'github.com/z7ping/agent-lens',
      createdAt: '2026-08-01T00:00:00Z',
    },
    capturedAt: '2026-08-27T23:00:00Z',
    dependencyRequired: true,
    phase: 'incremental',
    policy: full,
    history: fromNow,
  })
  assert.equal(result.historyAuthorization, 'minimum-dependency')
  assert.deepEqual(result.body.repositoryIdentity, { state: 'value', value: 'github.com/z7ping/agent-lens' })
  assert.deepEqual(result.body.name, { state: 'omitted', reason: 'dependency-minimized' })
  assert.deepEqual(result.body.createdAt, { state: 'omitted', reason: 'dependency-minimized' })
})

test('policy relaxation never authorizes automatic historical backfill', () => {
  assert.deepEqual(decideReplicationPolicyTransition(metadataOnly, full), {
    relation: 'relaxed',
    requireStreamRollover: false,
    requireReconcile: true,
    allowAutomaticHistoricalBackfill: false,
  })
  assert.equal(decideHistoryScopeTransition(fromNow, includeExisting).requireExplicitHistoricalAuthorization, true)
})

test('policy tightening requires stream rollover and reconcile', () => {
  assert.deepEqual(decideReplicationPolicyTransition(full, redacted), {
    relation: 'tightened',
    requireStreamRollover: true,
    requireReconcile: true,
    allowAutomaticHistoricalBackfill: false,
  })
})
