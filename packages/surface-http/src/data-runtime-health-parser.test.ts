import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDataRuntimeHealth } from './data-runtime-health'

function worker(role: 'writer' | 'reader') {
  return {
    state: 'ready' as const,
    role,
    protocolVersion: 1,
    pending: 0,
    maxPending: 16,
    requests: 10,
    completed: 10,
    timeouts: 0,
    durationMs: { last: 1, max: 2, p50: 1, p95: 2, p99: 2 },
  }
}

test('parseDataRuntimeHealth accepts the complete current contract', () => {
  const value = {
    ok: true,
    recovering: false,
    writer: worker('writer'),
    reader: worker('reader'),
    readers: [worker('reader')],
    maintenanceReader: worker('reader'),
    foregroundQueue: {
      queued: 0,
      maxQueued: 2,
      maxQueue: 16,
      overloads: 0,
      queueTimeouts: 0,
      waitBudgetMs: 50,
    },
  }
  assert.deepEqual(parseDataRuntimeHealth(value), value)
})

test('parseDataRuntimeHealth rejects partial or role-mismatched worker shapes', () => {
  assert.equal(parseDataRuntimeHealth({
    ok: false,
    recovering: true,
    writer: { state: 'degraded' },
    reader: { state: 'degraded' },
  }), undefined)

  assert.equal(parseDataRuntimeHealth({
    ok: true,
    recovering: false,
    writer: worker('reader'),
    reader: worker('reader'),
  }), undefined)
})
