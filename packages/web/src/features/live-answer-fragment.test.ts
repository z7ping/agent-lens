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
  assert.equal((html.match(/class="task-thinking task-process-group"/g) ?? []).length, 1)
  assert.match(html, /8 段思考/)
  assert.match(html, /16 次工具调用/)
})

test('Live 连续工具调用直接逐条展示，不再套一层工具调用分组', () => {
  const items = [
    { id: 'request', kind: 'message' as const, role: 'user' as const, text: '检查相关文件', streaming: false },
    { id: 'tool:1', kind: 'tool' as const, callId: 'call:1', name: 'read', status: 'success' as const, inputPreview: '{"path":"src/one.ts"}' },
    { id: 'tool:2', kind: 'tool' as const, callId: 'call:2', name: 'read', status: 'success' as const, inputPreview: '{"path":"src/two.ts"}' },
    { id: 'thought', kind: 'thinking' as const, text: '继续检查', streaming: false },
    { id: 'tool:3', kind: 'tool' as const, callId: 'call:3', name: 'shell', status: 'error' as const, inputPreview: 'exit 1' },
    { id: 'tool:4', kind: 'tool' as const, callId: 'call:4', name: 'shell', status: 'success' as const, inputPreview: 'pwd' },
    { id: 'tool:5', kind: 'tool' as const, callId: 'call:5', name: 'shell', status: 'success' as const, inputPreview: 'ls' },
    { id: 'tool:6', kind: 'tool' as const, callId: 'call:6', name: 'shell', status: 'success' as const, inputPreview: 'git status' },
  ]
  const projection = projectLiveTaskRounds(items)[0]!
  const html = renderToStaticMarkup(createElement(GenericLiveRound, {
    projection: { ...projection, model: { ...projection.model, state: 'running' } },
    agentLabel: 'Pi', eager: true, messageActions: [], actionPending: null,
    runtimeStreaming: true, onMessageAction: () => undefined,
  }))
  assert.equal((html.match(/data-tool-fact="true"/g) ?? []).length, 6)
  assert.equal((html.match(/class="task-tool-row"/g) ?? []).length, 6)
  assert.doesNotMatch(html, /live-tool-group|工具调用 6 项|live-tool-group-more/)
  assert.equal((html.match(/class="task-thinking task-process-group"/g) ?? []).length, 1)
  const renderedOrder = ['title="src/one.ts"', 'title="src/two.ts"', '继续检查', 'exit 1', 'pwd', 'ls', 'git status']
  let last = -1
  for (const entry of renderedOrder) {
    const next = html.indexOf(entry, last + 1)
    assert.ok(next > last, `缺少执行事件，或顺序错误：${entry}`)
    last = next
  }
  assert.match(html, /task-tool-status-error/)
  assert.match(html, /task-tool-status-ok/)
})
