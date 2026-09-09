import assert from 'node:assert/strict'
import test from 'node:test'
import type { PiLiveHistoryItem } from './pi-live-history'
import { projectPiLiveRunningRound, projectPiLiveTaskRounds } from './pi-live-task-projection'

function lifecycle(id: string): PiLiveHistoryItem {
  return {
    id,
    kind: 'lifecycle',
    event: 'test.event',
    label: '测试事件',
    detail: id,
    at: '2026-09-09T00:00:00.000Z',
  }
}

test('Pi Live 渲染分片共享同一个语义轮次身份', () => {
  const history: PiLiveHistoryItem[] = [
    { id: 'user-1', kind: 'message', role: 'user', text: '第一轮', at: '2026-09-09T00:00:00.000Z' },
    ...Array.from({ length: 9 }, (_, index) => lifecycle(`event-${index}`)),
  ]

  const projections = projectPiLiveTaskRounds(history)
  assert.equal(projections.length, 2)
  assert.notEqual(projections[0]?.model.id, projections[1]?.model.id)
  assert.equal(projections[0]?.model.semanticId, 'pi-round-1')
  assert.equal(projections[1]?.model.semanticId, 'pi-round-1')
  assert.equal(projections[0]?.continuation, false)
  assert.equal(projections[1]?.continuation, true)
})

test('不同语义轮次不能因为分片策略合并', () => {
  const history: PiLiveHistoryItem[] = [
    { id: 'user-1', kind: 'message', role: 'user', text: '第一轮', at: '2026-09-09T00:00:00.000Z' },
    lifecycle('event-1'),
    { id: 'user-2', kind: 'message', role: 'user', text: '第二轮', at: '2026-09-09T00:01:00.000Z' },
    lifecycle('event-2'),
  ]

  const projections = projectPiLiveTaskRounds(history)
  assert.deepEqual(projections.map(item => item.model.semanticId), ['pi-round-1', 'pi-round-2'])
})

test('Pi Live 当前轮次拥有稳定语义身份', () => {
  const round = projectPiLiveRunningRound({ items: [], isStreaming: true })
  assert.equal(round.semanticId, 'pi-live-current-round')
  assert.equal(round.state, 'running')
})
