import assert from 'node:assert/strict'
import test from 'node:test'
import type { PiLiveHistoryItem } from './pi-live-history'
import { piLiveSessionTitle, projectPiLiveHistoryIndexRound, projectPiLiveRunningRound, projectPiLiveTaskRounds, projectPiLiveTurnItems } from './pi-live-task-projection'

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

test('Pi Live 标题优先使用任务语义，不拼接来源标识', () => {
  assert.equal(piLiveSessionTitle({ sessionName: '修复目录选择无响应' }), '修复目录选择无响应')
  assert.equal(piLiveSessionTitle({ sessionName: '修复目录选择无响应', taskSummary: '验证 Windows 选择器' }), '验证 Windows 选择器')
  assert.equal(piLiveSessionTitle(null), '未命名任务')
})


test('Pi Live Turn 按 prompt → process 原序 → terminal → final 收敛', () => {
  const items: PiLiveHistoryItem[] = [
    { id: 'user', kind: 'message', role: 'user', text: '检查', at: '2026-09-09T00:00:00.000Z' },
    { id: 'assistant-tool', kind: 'thinking', text: '思考', at: '2026-09-09T00:00:01.000Z', contentIndex: 0 },
    { id: 'assistant-tool:content:1', kind: 'message', role: 'assistant', text: '我先检查', at: '2026-09-09T00:00:02.000Z', contentIndex: 1 },
    { id: 'model', kind: 'lifecycle', event: 'model.changed', label: '模型切换', detail: 'model-b', at: '2026-09-09T00:00:03.000Z' },
    { id: 'assistant-tool:content:2:tool:call', kind: 'tool', callId: 'call', name: 'bash', summary: 'git status', output: 'clean', status: 'success', at: '2026-09-09T00:00:04.000Z', contentIndex: 2 },
    { id: 'compact', kind: 'lifecycle', event: 'context.compaction', label: '上下文压缩', detail: '', at: '2026-09-09T00:00:05.000Z' },
    { id: 'assistant-final', kind: 'message', role: 'assistant', text: '完成', at: '2026-09-09T00:00:06.000Z', contentIndex: 0 },
    { id: 'assistant-final:stop', kind: 'lifecycle', event: 'assistant.stop', label: '结束', detail: 'stop', at: '2026-09-09T00:00:07.000Z', parentId: 'assistant-final' },
  ]
  const presented = projectPiLiveTurnItems(items)
  assert.deepEqual(presented.map(item => item.id), [
    'user', 'assistant-tool', 'assistant-tool:content:1', 'model',
    'assistant-tool:content:2:tool:call', 'compact', 'assistant-final:stop', 'assistant-final',
  ])
  assert.deepEqual(presented.map(item => item.turnSection), [
    'prompt', 'process', 'process', 'process', 'process', 'process', 'terminal', 'final',
  ])
})

test('Pi Live 在完整语义轮次分类后再分片，中间 Assistant 不会因分片变成最终回复', () => {
  const history: PiLiveHistoryItem[] = [
    { id: 'user', kind: 'message', role: 'user', text: '任务', at: '2026-09-09T00:00:00.000Z' },
    { id: 'tool-entry', kind: 'message', role: 'assistant', text: '中间输出', at: '2026-09-09T00:00:01.000Z', contentIndex: 0 },
    { id: 'tool-entry:content:1:tool:call', kind: 'tool', callId: 'call', name: 'read', summary: '', output: '', status: 'success', at: '2026-09-09T00:00:02.000Z', contentIndex: 1 },
    ...Array.from({ length: 7 }, (_, index) => ({ ...lifecycle(`meta-${index}`), at: `2026-09-09T00:00:${String(index + 3).padStart(2, '0')}.000Z` })),
    { id: 'final-entry', kind: 'message', role: 'assistant', text: '最终回复', at: '2026-09-09T00:00:10.000Z', contentIndex: 0 },
  ]
  const projections = projectPiLiveTaskRounds(history)
  const all = projections.flatMap(item => item.items)
  assert.equal(all.find(item => item.id === 'tool-entry')?.turnSection, 'process')
  assert.equal(all.find(item => item.id === 'final-entry')?.turnSection, 'final')
  assert.ok(projections.length > 1)
})


test('Pi Live 非终态 lifecycle 事件也参与最终回复边界', () => {
  const items: PiLiveHistoryItem[] = [
    { id: 'interim', kind: 'message', role: 'assistant', text: '处理中', at: '2026-09-09T00:00:01.000Z' },
    { id: 'model-change', kind: 'lifecycle', event: 'model.changed', label: '模型切换', detail: 'gpt-5.6', at: '2026-09-09T00:00:02.000Z' },
    { id: 'final', kind: 'message', role: 'assistant', text: '最终结果', at: '2026-09-09T00:00:03.000Z' },
  ]
  const presented = projectPiLiveTurnItems(items)
  assert.deepEqual(presented.map(item => [item.id, item.turnSection]), [
    ['interim', 'process'],
    ['model-change', 'process'],
    ['final', 'final'],
  ])
})


test('Pi Indexed 只有 Process duration 时不冒充整轮耗时', () => {
  const round = projectPiLiveHistoryIndexRound({
    cursor: 'user-2',
    ordinal: 2,
    summary: {
      promptText: '检查',
      finalText: '完成',
      process: {
        revision: 'rev-2',
        itemCount: 3,
        messageCount: 1,
        toolCount: 2,
        errorCount: 0,
        durationMs: 12_000,
        availability: 'available',
      },
    },
  })
  assert.equal(round.durationMs, 0)
  assert.equal(round.toolCount, 2)
})
