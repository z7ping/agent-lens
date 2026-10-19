import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { coalesceLiveSemanticRounds } from './live-semantic-rounds'
import { projectLiveTaskRounds, type LiveTaskProjectionItem } from './live-task-projection'
import { TaskReadingRound } from './TaskReadingRound'
import { TaskProcessGroup } from './TaskProcessGroup'
import { liveRoundOwnsAnswerActions } from './LiveTaskTimeline'

test('120 轮 + 1200 工具：视觉每轮一个 process，导轨语义数不跟虚拟碎片数增长', () => {
  const events: LiveTaskProjectionItem[] = []
  for (let round = 0; round < 120; round++) {
    events.push({ id: `user:${round}`, kind: 'message', role: 'user', text: `用户${round}`, streaming: false })
    for (let tool = 0; tool < 10; tool++) {
      events.push({ id: `tool:${round}:${tool}`, kind: 'tool', callId: `call:${round}:${tool}`, name: 'shell', status: 'success' })
    }
    events.push({ id: `answer:${round}`, kind: 'message', role: 'assistant', phase: 'final', text: '已完成', streaming: false })
  }
  const raw = projectLiveTaskRounds(events)
  const rounds = coalesceLiveSemanticRounds(raw)
  assert.ok(raw.length > rounds.length)
  assert.equal(rounds.length, 120)
  assert.equal(new Set(rounds.map(round => round.model.semanticId)).size, 120)
  assert.equal(rounds.reduce((sum, round) => sum + round.model.toolCount, 0), 1200)
  const markup = renderToStaticMarkup(createElement('div', null, rounds.map(round =>
    createElement(TaskReadingRound, {
      key: round.model.id,
      model: round.model,
      process: createElement(TaskProcessGroup, {
        id: `process:${round.model.id}`, messageCount: 0, thinkingCount: 0,
        toolCount: round.model.toolCount, state: 'settled', defaultExpanded: false, children: 'hidden process',
      }),
      answer: '已完成',
    }),
  )))
  assert.equal((markup.match(/class="task-reading-round/g) ?? []).length, 120)
  assert.equal((markup.match(/处理详情/g) ?? []).length, 120)
  assert.doesNotMatch(markup, /hidden process/)
  assert.equal(rounds.filter((_, index) => liveRoundOwnsAnswerActions(rounds, index)).length, 120)
})
