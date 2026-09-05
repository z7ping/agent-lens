import assert from 'node:assert/strict'
import test from 'node:test'
import { compressLegacySourceRecords } from './storage-maintenance'

test('旧 SourceRecord 压缩按前台空闲批次执行直到完成', async () => {
  let waits = 0
  let yields = 0
  const batchSizes: number[] = []
  const reported: number[] = []
  const batches = [
    { scanned: 2, compressed: 2, plain: 0, rawBytes: 2000, storedBytes: 600, savedBytes: 1400, hasMore: true },
    { scanned: 1, compressed: 0, plain: 1, rawBytes: 200, storedBytes: 200, savedBytes: 0, hasMore: false },
  ]
  const result = await compressLegacySourceRecords(
    {
      async compressSourceRecords(limit) {
        batchSizes.push(limit ?? 0)
        return batches.shift()!
      },
    },
    { async wait() { waits += 1 } },
    new AbortController().signal,
    {
      batchSize: 250,
      onBatch: batch => reported.push(batch.scanned),
      yieldControl: async () => { yields += 1 },
    },
  )

  assert.deepEqual(batchSizes, [250, 250])
  assert.equal(waits, 2)
  assert.equal(yields, 1)
  assert.deepEqual(reported, [2, 1])
  assert.deepEqual(result, {
    scanned: 3,
    compressed: 2,
    plain: 1,
    savedBytes: 1400,
    batches: 2,
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
        return { scanned: 1, compressed: 1, plain: 0, rawBytes: 1000, storedBytes: 200, savedBytes: 800, hasMore: false }
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
