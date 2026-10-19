import assert from 'node:assert/strict'
import test from 'node:test'
import { liveRoundOwnsAnswerActions } from './LiveTaskTimeline'
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
