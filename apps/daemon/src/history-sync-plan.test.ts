import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createProgressiveHistoryStages,
  stagesAllowedByCapacity,
  storageCapacityState,
  yieldToForeground,
} from './history-sync-plan'

test('历史同步按最新 1 个、最近 10 个、最近 7 天渐进调度', () => {
  const stages = createProgressiveHistoryStages(Date.parse('2026-09-01T00:00:00.000Z'))
  assert.deepEqual(stages.map(stage => ({ id: stage.id, window: stage.window })), [
    { id: 'latest', window: { activeSince: '2026-08-25T00:00:00.000Z', sessionLimit: 1 } },
    { id: 'recent', window: { activeSince: '2026-08-25T00:00:00.000Z', sessionLimit: 10 } },
    { id: 'hot-window', window: { activeSince: '2026-08-25T00:00:00.000Z' } },
  ])
})

test('数据库接近软阈值时暂停 7 天回填，超过预算时暂停全部批量历史', () => {
  const stages = createProgressiveHistoryStages(Date.parse('2026-09-01T00:00:00.000Z'))
  assert.deepEqual(stagesAllowedByCapacity(stages, 'healthy').map(stage => stage.id), ['latest', 'recent', 'hot-window'])
  assert.deepEqual(stagesAllowedByCapacity(stages, 'approaching').map(stage => stage.id), ['latest', 'recent'])
  assert.deepEqual(stagesAllowedByCapacity(stages, 'exceeded').map(stage => stage.id), [])
  assert.equal(storageCapacityState({ dataGrowth: { capacity: { state: 'exceeded' } } }), 'exceeded')
  assert.equal(storageCapacityState(undefined), 'unknown')
})

test('前台让出点在取消后立即结束', async () => {
  const controller = new AbortController()
  controller.abort()
  await yieldToForeground(controller.signal)
  assert.equal(controller.signal.aborted, true)
})
