import assert from 'node:assert/strict'
import test from 'node:test'
import { compressLegacySourceRecords } from './storage-maintenance'

test('旧 SourceRecord 压缩按前台空闲批次执行并逐批持久游标', async () => {
  let waits = 0
  let yields = 0
  const calls: Array<{ limit: number; afterId?: string }> = []
  const reportedBatches: number[] = []
  const progress: unknown[] = []
  const batches = [
    { scanned: 2, compressed: 2, plain: 0, rawBytes: 2000, storedBytes: 600, savedBytes: 1400, cursor: 'record-b', hasMore: true },
    { scanned: 1, compressed: 0, plain: 1, rawBytes: 200, storedBytes: 200, savedBytes: 0, cursor: 'record-c', hasMore: false },
  ]
  const result = await compressLegacySourceRecords(
    {
      async compressSourceRecords(limit, afterId) {
        calls.push({ limit: limit ?? 0, ...(afterId ? { afterId } : {}) })
        return batches.shift()!
      },
    },
    { async wait() { waits += 1 } },
    new AbortController().signal,
    {
      initialProgress: { scanned: 10, compressed: 5, plain: 5, savedBytes: 5000, batches: 4, cursor: 'record-a' },
      batchSize: 250,
      onBatch: batch => reportedBatches.push(batch.scanned),
      report: async value => { progress.push(value); return true },
      yieldControl: async () => { yields += 1 },
    },
  )

  assert.deepEqual(calls, [
    { limit: 250, afterId: 'record-a' },
    { limit: 250, afterId: 'record-b' },
  ])
  assert.equal(waits, 2)
  assert.equal(yields, 1)
  assert.deepEqual(reportedBatches, [2, 1])
  assert.deepEqual(progress, [
    { scanned: 12, compressed: 7, plain: 5, savedBytes: 6400, batches: 5, cursor: 'record-b' },
    { scanned: 13, compressed: 7, plain: 6, savedBytes: 6400, batches: 6, cursor: 'record-c' },
  ])
  assert.deepEqual(result, {
    scanned: 13,
    compressed: 7,
    plain: 6,
    savedBytes: 6400,
    batches: 6,
    cursor: 'record-c',
    aborted: false,
  })
})

test('旧 SourceRecord 压缩在前台等待期间取消后不进入下一批', async () => {
  const controller = new AbortController()
  let compressCalls = 0
  const result = await compressLegacySourceRecords(
    {
      async compressSourceRecords() {
        compressCalls += 1
        return {
          scanned: 1,
          compressed: 1,
          plain: 0,
          rawBytes: 1000,
          storedBytes: 200,
          savedBytes: 800,
          cursor: 'record-a',
          hasMore: false,
        }
      },
    },
    {
      async wait() { controller.abort() },
    },
    controller.signal,
  )
  assert.equal(compressCalls, 0)
  assert.equal(result.aborted, true)
})
