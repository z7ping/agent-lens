import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createProgressiveHistoryStages,
  createParserReplayStages,
  stagesAllowedByCapacity,
  storageCapacityState,
  yieldToForeground,
} from './history-sync-plan'

test('历史同步按最新 1 个、最近 10 个、最近 7 天渐进调度', () => {
  const stages = createProgressiveHistoryStages(Date.parse('2026-09-01T00:00:00.000Z'))
  assert.deepEqual(stages.map(stage => ({ id: stage.id, window: stage.window })), [
    { id: 'latest', window: { sessionLimit: 1 } },
    { id: 'recent', window: { sessionLimit: 10 } },
    { id: 'hot-window', window: { activeSince: '2026-08-25T00:00:00.000Z' } },
  ])
})

test('最新与最近会话不受热窗口限制', () => {
  const stages = createProgressiveHistoryStages(Date.parse('2026-09-01T00:00:00.000Z'))
  assert.equal(stages[0]?.window.activeSince, undefined)
  assert.equal(stages[1]?.window.activeSince, undefined)
  assert.equal(stages[2]?.window.activeSince, '2026-08-25T00:00:00.000Z')
})

test('数据库接近软阈值时暂停 7 天回填，超过预算时仍同步最新 1 个会话', () => {
  const stages = createProgressiveHistoryStages(Date.parse('2026-09-01T00:00:00.000Z'))
  assert.deepEqual(stagesAllowedByCapacity(stages, 'healthy').map(stage => stage.id), ['latest', 'recent', 'hot-window'])
  assert.deepEqual(stagesAllowedByCapacity(stages, 'approaching').map(stage => stage.id), ['latest', 'recent'])
  assert.deepEqual(stagesAllowedByCapacity(stages, 'exceeded').map(stage => stage.id), ['latest'])
  assert.equal(storageCapacityState({ dataGrowth: { capacity: { state: 'exceeded' } } }), 'exceeded')
  assert.equal(storageCapacityState(undefined), 'unknown')
})

test('parser 语义重放独立于原生历史容量降级并最终覆盖全部持久化记录', () => {
  const stages = createParserReplayStages(Date.parse('2026-09-01T00:00:00.000Z'))
  assert.deepEqual(stages.map(stage => ({ id: stage.id, window: stage.window })), [
    { id: 'recent', window: { sessionLimit: 10 } },
    { id: 'hot-window', window: { activeSince: '2026-08-25T00:00:00.000Z' } },
    { id: 'all', window: undefined },
  ])
})

test('前台让出点在取消后立即结束', async () => {
  const controller = new AbortController()
  controller.abort()
  await yieldToForeground(controller.signal)
  assert.equal(controller.signal.aborted, true)
})
