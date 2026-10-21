import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReviewMessageNodeDto, ReviewToolNodeDto } from '@agent-lens/protocol'
import { ReviewProcessGroup } from './ReviewRoundPresentation'
import type { ReviewProcessPresentationItem } from './review-interaction-presentation'

const at = '2026-10-19T12:00:00.000Z'

function tool(index: number): ReviewToolNodeDto {
  return {
    type: 'tool',
    id: `native-tool-${index}`,
    sourceId: 'codex',
    name: `native_call_${index}`,
    status: index === 84 ? 'error' : index === 96 ? 'running' : 'success',
    at,
    startedAt: at,
    payload: {},
    evidence: [],
    observationIds: [`obs:tool:${index}`],
    capturedAt: at,
  }
}

function thinking(index: number): ReviewMessageNodeDto {
  return {
    type: 'message',
    id: `thought-${index}`,
    role: 'reasoning',
    sourceId: 'codex',
    at,
    text: `native reasoning ${index}`,
    payload: {},
    evidence: [],
    observationIds: [`obs:thought:${index}`],
    capturedAt: at,
  }
}

test('Review 116 次工具按思考分为 58 个独立相邻组，不整轮折叠', () => {
  const items: ReviewProcessPresentationItem[] = []
  for (let index = 0; index < 58; index += 1) {
    items.push({ type: 'tool-group', items: [tool(index * 2 + 1), tool(index * 2 + 2)] })
    items.push({ type: 'message', node: thinking(index) })
  }
  const html = renderToStaticMarkup(createElement(ReviewProcessGroup, {
    id: 'process:116',
    items,
    inspect: () => undefined,
    state: 'settled',
    showAllEvents: false,
    expansionStore: new Map([['process:116', true]]),
  }))

  assert.equal((html.match(/data-task-tool-group="true"/g) ?? []).length, 58)
  assert.doesNotMatch(html, /工具调用 · 116 项/)
  assert.match(html, /展开 1 项/)
  assert.equal((html.match(/data-tool-fact="true"/g) ?? []).length, 59)
  assert.doesNotMatch(html, /native_call_4/)
  assert.match(html, /native_call_84/)
  assert.doesNotMatch(html, /native_call_96/)
  assert.match(html, /native reasoning 0/)
  assert.match(html, /native reasoning 57/)
  assert.equal((html.match(/class="task-thinking task-process-thinking-card"/g) ?? []).length, 58)
})


test('Review preserves tool boundaries across different reasoning parents', () => {
  const items: ReviewProcessPresentationItem[] = [
    { type: 'tool-group', parentReasoningId: 'parent-a', items: [tool(1), tool(2), tool(3), tool(4)] },
    { type: 'tool-group', parentReasoningId: 'parent-b', items: [tool(5), tool(6), tool(7), tool(8)] },
  ]
  const html = renderToStaticMarkup(createElement(ReviewProcessGroup, {
    id: 'process:parents', items, inspect: () => undefined,
    state: 'settled', showAllEvents: false,
    expansionStore: new Map([['process:parents', true]]),
  }))
  assert.equal((html.match(/data-task-tool-group="true"/g) ?? []).length, 2)
  assert.equal((html.match(/data-tool-fact="true"/g) ?? []).length, 2)
  assert.doesNotMatch(html, /native_call_4|native_call_8/)
})

test('Review separates adjacent tool batches even with the same reasoning parent', () => {
  const items: ReviewProcessPresentationItem[] = [
    { type: 'tool-group', parentReasoningId: 'same', items: [tool(1), tool(2)] },
    { type: 'tool-group', parentReasoningId: 'same', items: [tool(3), tool(4)] },
    { type: 'tool-group', items: [tool(5)] },
  ]
  const html = renderToStaticMarkup(createElement(ReviewProcessGroup, {
    id: 'process:hidden-interruption', items, inspect: () => undefined,
    state: 'settled', showAllEvents: false,
    expansionStore: new Map([['process:hidden-interruption', true]]),
  }))
  assert.equal((html.match(/data-task-tool-group="true"/g) ?? []).length, 2)
  assert.equal((html.match(/data-tool-fact="true"/g) ?? []).length, 3)
  assert.match(html, /native_call_1/)
  assert.match(html, /native_call_3/)
  assert.match(html, /native_call_5/)
  assert.doesNotMatch(html, /native_call_2|native_call_4/)
})
