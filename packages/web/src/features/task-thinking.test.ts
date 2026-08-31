import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskThinking } from './TaskThinking'
import type { TaskThinkingModel } from './task-detail-model'

const model: TaskThinkingModel = {
  id: 'thinking:test',
  label: '思考',
  text: '核对原型与正式实现。',
  preview: '核对原型与正式实现。',
  time: '09:01',
  state: 'settled',
}

test('TaskThinking 按原型默认展开并保留执行轨节点结构', () => {
  const html = renderToStaticMarkup(createElement(TaskThinking, { model, children: '核对原型与正式实现。' }))
  assert.match(html, /<details[^>]*open=""/)
  assert.match(html, /thinking-node agent-lane-node/)
  assert.match(html, /thinking-preview node-preview/)
  assert.match(html, /核对原型与正式实现/)
})

test('TaskThinking 仍允许调用方显式默认折叠', () => {
  const html = renderToStaticMarkup(createElement(TaskThinking, { model, defaultExpanded: false, children: '核对原型与正式实现。' }))
  assert.doesNotMatch(html, /<details[^>]*open=""/)
  assert.match(html, /thinking-node agent-lane-node/)
})
