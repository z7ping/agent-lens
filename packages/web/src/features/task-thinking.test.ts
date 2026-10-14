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


test('执行过程调用方显式折叠时不再被内部逻辑强制展开', () => {
  const processModel: TaskThinkingModel = {
    ...model,
    id: 'thinking:process',
    label: '思考过程',
  }
  const html = renderToStaticMarkup(createElement(TaskThinking, {
    model: processModel,
    defaultExpanded: false,
    children: '过程正文',
  }))
  assert.doesNotMatch(html, /<details[^>]*open=""/)
  assert.doesNotMatch(html, /过程正文/)
})


test('展开状态可由外部 store 恢复，供虚拟列表卸载后重建', () => {
  const store = new Map<string, boolean>([[model.id, true]])
  const html = renderToStaticMarkup(createElement(TaskThinking, {
    model,
    defaultExpanded: false,
    expansionStore: store,
    children: '恢复后的处理正文',
  }))
  assert.match(html, /<details[^>]*open=""/)
  assert.match(html, /恢复后的处理正文/)
})

test('共享处理详情只在唯一摘要入口展示大脑图标，不额外插入思考折叠层', () => {
  const running = renderToStaticMarkup(createElement(TaskThinking, {
    model: { ...model, state: 'running' },
    kind: 'thinking',
    children: '正在分析',
  }))
  assert.match(running, /data-task-thinking-state="running"/)
  assert.match(running, /aria-busy="true"/)
  assert.doesNotMatch(running, /task-thinking-kind-mark/)
  assert.match(running, /task-thinking-running-mark/)
  const process = renderToStaticMarkup(createElement(TaskThinking, {
    model: { ...model, id: 'process:test' },
    kind: 'process',
    defaultExpanded: false,
    children: '历史处理详情',
  }))
  assert.match(process, /task-thinking-kind-mark/)
  assert.match(process, /task-thinking-running-mark/)
  // 同一个 disclosure 承担摘要与展开；BrainCircuit 是现有 UiIcon.thinking。
  assert.match(process, /lucide-brain-circuit|lucide-brain|brain-circuit/i)
})

