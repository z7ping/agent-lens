import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectionBackfillMaintenance } from '@agent-lens/core'
import { ForegroundActivityGate } from './maintenance-idle'
import { backfillToolUsageFactProjection } from './projection-backfill-maintenance'

const gate = { wait: async () => undefined }

test('Tool Fact ready skips cursor repair and backfill entirely', async () => {
  let repairs = 0
  let batches = 0
  const maintenance: ProjectionBackfillMaintenance = {
    backfillUnknownObservations: async () => ({ scanned: 0, written: 0, hasMore: false }),
    backfillToolUsageFacts: async () => { batches += 1; return { scanned: 0, written: 0, hasMore: false } },
    toolUsageFactCoverage: async () => ({ sourceObservationCount: 2, projectedCount: 2, missingCount: 0, coverageRatio: 1, ready: true }),
    repairToolUsageFactCursor: async after => { repairs += 1; return after },
  }

  const result = await backfillToolUsageFactProjection(maintenance, gate, new AbortController().signal, {
    initialProgress: { cursor: 'z', scanned: 2, written: 2, batches: 1 },
  })

  assert.equal(repairs, 0)
  assert.equal(batches, 0)
  assert.deepEqual(result, { scanned: 0, written: 0, batches: 0, aborted: false })
})

test('Tool Fact partial repairs persisted cursor once then advances batches normally', async () => {
  let repairs = 0
  const seenAfter: Array<string | undefined> = []
  const maintenance: ProjectionBackfillMaintenance = {
    backfillUnknownObservations: async () => ({ scanned: 0, written: 0, hasMore: false }),
    toolUsageFactCoverage: async () => ({ sourceObservationCount: 2, projectedCount: 1, missingCount: 1, coverageRatio: 0.5, ready: false }),
    repairToolUsageFactCursor: async () => { repairs += 1; return undefined },
    backfillToolUsageFacts: async after => {
      seenAfter.push(after)
      if (!after) return { scanned: 1, written: 1, cursor: 'a', hasMore: true }
      return { scanned: 1, written: 1, cursor: 'b', hasMore: false }
    },
  }

  const result = await backfillToolUsageFactProjection(maintenance, gate, new AbortController().signal, {
    initialProgress: { cursor: 'z', scanned: 100, written: 100, batches: 10 },
    yieldControl: async () => undefined,
  })

  assert.equal(repairs, 1)
  assert.deepEqual(seenAfter, [undefined, 'a'])
  assert.equal(result.scanned, 2)
  assert.equal(result.written, 2)
  assert.equal(result.batches, 2)
  assert.equal(result.cursor, 'b')
})

test('Tool Fact backfill keeps making bounded progress under sustained foreground reads', async () => {
  let now = 0
  let batches = 0
  const foregroundGate = new ForegroundActivityGate({
    quietMs: 5_000,
    maxDeferMs: 300,
    pollMs: 100,
    now: () => now,
    loadProbe: () => ({ foregroundPending: 1, writerPending: 0 }),
    sleep: async ms => { now += ms },
  })
  const maintenance: ProjectionBackfillMaintenance = {
    backfillUnknownObservations: async () => ({ scanned: 0, written: 0, hasMore: false }),
    toolUsageFactCoverage: async () => ({ sourceObservationCount: 2, projectedCount: 0, missingCount: 2, coverageRatio: 0, ready: false }),
    repairToolUsageFactCursor: async after => after,
    backfillToolUsageFacts: async after => {
      batches += 1
      return batches === 1
        ? { scanned: 1, written: 1, cursor: 'a', hasMore: true }
        : { scanned: 1, written: 1, cursor: after === 'a' ? 'b' : 'unexpected', hasMore: false }
    },
  }

  const result = await backfillToolUsageFactProjection(
    maintenance,
    foregroundGate,
    new AbortController().signal,
    { batchSize: 1, yieldControl: async () => undefined },
  )

  assert.equal(now, 600, 'each bounded batch earns its own maximum-defer window')
  assert.equal(batches, 2)
  assert.equal(result.written, 2)
  assert.equal(result.cursor, 'b')
  assert.equal(foregroundGate.snapshot().permits.forced, 2)
})
