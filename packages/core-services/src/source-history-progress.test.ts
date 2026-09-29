import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRuntimeStatus, SourceSyncProgress, StorageService } from '@agent-lens/core'
import { queuedHistoryStatus, SourceHistoryProgressTracker } from './source-history-progress'

function sink() {
  const writes: SourceRuntimeStatus[] = []
  const storage = { sourceRuntimeStatus: { async put(value: SourceRuntimeStatus) { writes.push({ ...value }) } } } as unknown as StorageService
  return { storage, writes }
}

test('同步计数节流，阶段与最终结果立即落盘，检测和排队节点保留', async t => {
  const { storage, writes } = sink()
  const status = queuedHistoryStatus('codex', 'local')
  const tracker = new SourceHistoryProgressTracker(storage, status)
  t.after(() => tracker.dispose())
  await tracker.begin()
  await tracker.report({ phase: 'processing', discoveredUnits: 12, processedUnits: 0 })
  const before = writes.length
  for (let index = 1; index <= 100; index++) await tracker.record({ records: index, observationsCreated: index, observationsMerged: 0, observationsUnchanged: 0 })
  assert.ok(writes.length <= before + 1, '不能每处理一条记录就写入进度')
  await tracker.phase('checkpoint')
  await tracker.settle('completed')
  const final = JSON.parse(writes.at(-1)!.checkpointSummary!) as SourceSyncProgress
  assert.equal(writes.at(-1)!.state, 'healthy')
  assert.equal(final.records, 100)
  assert.equal(final.discoveredUnits, 12)
  assert.ok(final.steps.every(step => step.state === 'completed'))
  assert.equal(final.runId, JSON.parse(status.checkpointSummary!).runId)
})

test('排队取消和处理中失败保持真实终态，不被标记为同步完成', async t => {
  const { storage, writes } = sink()
  const queued = new SourceHistoryProgressTracker(storage, queuedHistoryStatus('pi', 'local'))
  await queued.settle('cancelled')
  assert.equal(queued.progress.steps.find(step => step.id === 'waiting')?.state, 'cancelled')
  assert.equal(queued.progress.steps.find(step => step.id === 'finished')?.state, 'pending')
  const tracker = new SourceHistoryProgressTracker(storage, queuedHistoryStatus('hermes', 'local'))
  t.after(() => tracker.dispose())
  await tracker.begin()
  await tracker.report({ phase: 'processing' })
  await tracker.settle('failed', '原生数据读取失败')
  assert.equal(writes.at(-1)!.state, 'failed')
  assert.equal(tracker.progress.steps.find(step => step.id === 'processing')?.state, 'failed')
  assert.equal(tracker.progress.steps.find(step => step.id === 'finished')?.state, 'pending')
})
