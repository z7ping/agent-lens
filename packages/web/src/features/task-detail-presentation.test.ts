import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskMessage } from './TaskMessage'
import { TaskRound } from './TaskRound'
import { TaskToolGroup } from './TaskToolGroup'
import type { TaskRoundModel, TaskToolGroupModel } from './task-detail-model'

const toolGroup: TaskToolGroupModel = {
  id: 'tools:test',
  label: '工具执行',
  itemCount: 4,
  errorCount: 0,
  kindCounts: [],
  tools: [
    { id: 'read', name: '读取文件', kind: 'read', kindLabel: '读取', status: 'success', primary: 'packages/web/src/App.tsx', durationMs: 42 },
    { id: 'search', name: '代码搜索', kind: 'search', kindLabel: '搜索', status: 'success', primary: 'startedAt / capturedAt', durationMs: 51 },
    { id: 'test', name: 'npm test', kind: 'tool', kindLabel: '工具', status: 'success', primary: 'packages/web', durationMs: 830 },
    { id: 'unknown', name: 'custom_native_call', kind: 'tool', kindLabel: '工具', status: 'success', primary: 'opaque target' },
  ],
}

const round: TaskRoundModel = {
  id: 'round:test',
  label: '第 3 轮',
  state: 'settled',
  preview: '核对 Tool / Thinking / Message 层级',
  toolCount: 4,
  errorCount: 0,
  durationMs: 108_000,
  highLatency: false,
}

test('成功 Tool Group 默认展开并逐条保留 Tool Call 事实', () => {
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: toolGroup }))
  assert.match(html, /<details[^>]*open=""[^>]*data-task-tool-group="true"/)
  assert.equal((html.match(/data-tool-fact="true"/g) ?? []).length, 4)
  assert.match(html, /读取 → 搜索 → 测试 → 工具/)
  assert.match(html, /4 次/)
})

test('测试类和未知 Tool 使用稳定语义降级而不是通用突兀占位', () => {
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: toolGroup }))
  assert.match(html, /data-kind="test"/)
  assert.match(html, />测试</)
  assert.match(html, /data-kind="tool"/)
  assert.match(html, />工具</)
})

test('Round 保持原型轻量摘要结构并默认展开', () => {
  const html = renderToStaticMarkup(createElement(TaskRound, { model: round }, 'content'))
  assert.match(html, /class="task-round interaction-block/)
  assert.match(html, /<details[^>]*open=""/)
  assert.match(html, /round-label/)
  assert.match(html, /round-preview/)
  assert.match(html, /round-meta/)
  assert.match(html, /4 调用/)
})

test('Message 保持用户右 / Agent 左的单一正文结构', () => {
  const user = renderToStaticMarkup(createElement(TaskMessage, { role: 'user', text: '用户消息', collapsible: false }))
  const assistant = renderToStaticMarkup(createElement(TaskMessage, { role: 'assistant', text: '智能体回复', collapsible: false }))
  assert.match(user, /message-row[^\"]*user/)
  assert.match(user, /chat-bubble-user/)
  assert.doesNotMatch(user, /task-message-agent-mark/)
  assert.match(assistant, /message-row[^\"]*agent/)
  assert.match(assistant, /task-message-agent-mark/)
  assert.match(assistant, /chat-bubble-agent/)
})
