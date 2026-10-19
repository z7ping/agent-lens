import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GenericLiveRound, liveRoundOwnsAnswerActions } from './LiveTaskTimeline'
import { projectLiveTaskRounds } from './live-task-projection'
import type { LiveTaskRoundProjection } from './live-task-projection'

function fragment(id: string, semanticId: string, kind: 'answer' | 'tool' | 'commentary'): LiveTaskRoundProjection {
  return {
    model: { id, semanticId, label: id, state: 'settled', toolCount: kind === 'tool' ? 1 : 0,
      errorCount: 0, durationMs: 0, highLatency: false },
    items: kind === 'tool'
      ? [{ id: 'tool:' + id, kind: 'tool', callId: 'call:' + id, name: 'shell', status: 'success' }]
      : [{ id: 'message:' + id, kind: 'message', role: 'assistant',
        phase: kind === 'commentary' ? 'commentary' : 'final', text: id, streaming: false }],
  }
}

test('同一个长轮次跨虚拟块只把操作放在最后一段可读答复', () => {
  const items = [
    fragment('a', 'semantic:1', 'answer'),
    fragment('b', 'semantic:1', 'tool'),
    fragment('c', 'semantic:2', 'commentary'),
    fragment('d', 'semantic:2', 'answer'),
    fragment('e', 'semantic:2', 'tool'),
  ]
  assert.deepEqual(items.map((_, index) => liveRoundOwnsAnswerActions(items, index)), [
    true, false, false, true, false,
  ])
})

test('一个语义轮包含多条正式答复时，只有最后一段有复制与源码', () => {
  const items = [fragment('first', 'same', 'answer'), fragment('last', 'same', 'answer')]
  assert.equal(liveRoundOwnsAnswerActions(items, 0), false)
  assert.equal(liveRoundOwnsAnswerActions(items, 1), true)
})

test('单条长请求包含多段思考与工具时，UI 只输出一条处理详情', () => {
  const items = [
    { id: 'request', kind: 'message' as const, role: 'user' as const, text: '启动三台虚拟机', streaming: false },
    ...Array.from({ length: 24 }, (_, index) => index % 3 === 0
      ? { id: `thinking-${index}`, kind: 'thinking' as const, text: '检查状态', streaming: false }
      : { id: `tool-${index}`, kind: 'tool' as const, callId: `call-${index}`, name: 'shell', status: 'success' as const }),
    { id: 'answer', kind: 'message' as const, role: 'assistant' as const, text: '完成', streaming: false },
  ]
  const rounds = projectLiveTaskRounds(items)
  assert.equal(rounds.length, 1)
  const html = renderToStaticMarkup(createElement(GenericLiveRound, {
    projection: rounds[0]!, agentLabel: 'Pi', eager: true,
    messageActions: [], actionPending: null, runtimeStreaming: false,
    onMessageAction: () => undefined,
  }))
  assert.equal((html.match(/class="task-thinking task-process-group live-task-process"/g) ?? []).length, 1)
  assert.match(html, /8 段思考/)
  assert.match(html, /16 次工具调用/)
})
