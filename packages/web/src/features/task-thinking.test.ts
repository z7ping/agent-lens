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

test('TaskThinking 默认展开并只暴露 Task Surface 规范类名', () => {
  const html = renderToStaticMarkup(createElement(TaskThinking, { model, children: '核对原型与正式实现。' }))
  assert.match(html, /<details[^>]*open=""/)
  assert.match(html, /class="task-thinking"/)
  assert.match(html, /task-thinking-summary/)
  assert.doesNotMatch(html, /task-thinking-preview/)
  assert.match(html, /task-thinking-content">核对原型与正式实现/)
  assert.doesNotMatch(html, /thinking-block|thinking-node|agent-lane-node|node-preview/)
})

test('TaskThinking 折叠时显示弱预览且仍允许调用方显式默认折叠', () => {
  const html = renderToStaticMarkup(createElement(TaskThinking, { model, defaultExpanded: false, children: '核对原型与正式实现。' }))
  assert.doesNotMatch(html, /<details[^>]*open=""/)
  assert.match(html, /class="task-thinking"/)
  assert.match(html, /task-thinking-preview/)
  assert.doesNotMatch(html, /task-thinking-content/)
  assert.doesNotMatch(html, /核对原型与正式实现。<\/div>/)
})
