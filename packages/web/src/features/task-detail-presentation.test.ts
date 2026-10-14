import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PiLiveCurrentTaskRound } from './PiLiveTaskRound'
import { TaskMessage } from './TaskMessage'
import { TaskRound } from './TaskRound'
import { TaskToolGroup } from './TaskToolGroup'
import { TaskThinking } from './TaskThinking'
import type { TaskRoundModel, TaskToolGroupModel } from './task-detail-model'

const toolGroup: TaskToolGroupModel = {
  id: 'tools:test', label: '工具执行', itemCount: 4, errorCount: 0, kindCounts: [],
  tools: [
    { id: 'read', name: '读取文件', kind: 'read', kindLabel: '读取', status: 'success', primary: 'packages/web/src/App.tsx', durationMs: 42 },
    { id: 'search', name: '代码搜索', kind: 'search', kindLabel: '搜索', status: 'success', primary: 'startedAt / capturedAt', durationMs: 51 },
    { id: 'test', name: 'run_checks', kind: 'tool', kindLabel: '工具', status: 'success', primary: 'npm test packages/web', durationMs: 830 },
    { id: 'unknown', name: 'custom_native_call', kind: 'tool', kindLabel: '工具', status: 'success', primary: 'opaque target' },
  ],
}
const round: TaskRoundModel = { id: 'round:test', label: '第 3 轮', state: 'settled', preview: '核对 Tool / Thinking / Message 层级', toolCount: 4, errorCount: 0, durationMs: 108_000, highLatency: false }
const runningRound: TaskRoundModel = { id: 'round:running', label: '第 6 轮', state: 'running', preview: '当前执行', toolCount: 1, errorCount: 0, durationMs: 0, highLatency: false }

test('Tool Group 不再生成独立“执行过程 / 工具执行”父层', () => {
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: toolGroup }))
  assert.match(html, /data-task-tool-group="true"/)
  assert.doesNotMatch(html, /<details[^>]*data-task-tool-group/)
  assert.equal((html.match(/data-tool-fact="true"/g) ?? []).length, 4)
})

test('测试类和未知 Tool 使用稳定语义降级', () => {
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: toolGroup }))
  // npm test is only a native name, not evidence that the call belongs to
  // the 'test' tool kind. Both it and unknown calls remain generic.
  assert.doesNotMatch(html, /data-kind="test"/)
  assert.doesNotMatch(html, /task-tool-kind-test/)
  assert.equal((html.match(/data-kind="tool"/g) ?? []).length, 2)
  assert.match(html, />工具</)
})

test('Round 保持轻量摘要结构并默认展开', () => {
  const html = renderToStaticMarkup(createElement(TaskRound, { model: round, children: 'content' }))
  assert.match(html, /class="task-round interaction-block/)
  assert.match(html, /<details[^>]*open=""/)
  assert.match(html, /task-round-label/)
  assert.match(html, /task-round-preview/)
  assert.match(html, /task-round-meta/)
  assert.match(html, /4 调用/)
})

test('Round 折叠时不挂载轮次正文', () => {
  const html = renderToStaticMarkup(createElement(TaskRound, { model: round, defaultExpanded: false, children: 'content' }))
  assert.doesNotMatch(html, /<details[^>]*open=""/)
  assert.doesNotMatch(html, /task-round-flow/)
  assert.doesNotMatch(html, />content</)
})

test('用户保留右侧气泡，Agent 无头像且不恢复历史视觉别名', () => {
  const user = renderToStaticMarkup(createElement(TaskMessage, { role: 'user', text: '用户消息', collapsible: false }))
  const assistant = renderToStaticMarkup(createElement(TaskMessage, { role: 'assistant', text: '智能体回复', modelLabel: 'test / model-1', collapsible: false }))
  assert.match(user, /task-message-row task-message-user/)
  assert.match(user, /task-message-bubble-user/)
  assert.doesNotMatch(user, />源码</)
  assert.match(assistant, /task-message-row task-message-assistant/)
  assert.match(assistant, /task-message-bubble-assistant/)
  assert.match(assistant, /task-message-model-meta/)
  assert.match(assistant, /test \/ model-1/)
  assert.match(assistant, /task-message-copy-action/)
  assert.match(assistant, />源码</)
  assert.doesNotMatch(user, /class="(?:message-row|chat-bubble)(?:\s|\")/)
  assert.doesNotMatch(assistant, /class="(?:message-row|chat-bubble)(?:\s|\")/)
})

test('默认 Tool 摘要一行展示类型、名称和状态图标，原始数据只在展开后出现', () => {
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: toolGroup }))
  assert.equal((html.match(/<summary class="task-tool-row"/g) ?? []).length, 4)
  assert.equal((html.match(/<details class="task-tool-call/g) ?? []).length, 4)
  assert.doesNotMatch(html, /<details class="task-tool-call[^>]*open=""/)
  assert.match(html, /task-tool-summary-text/)
  assert.match(html, /task-tool-status-mark/)
  assert.match(html, /task-tool-row-chevron/)
})

test('Pi Running Tool 收在单一处理详情中，运行中摘要默认折叠且不丢失调用统计', () => {
  const html = renderToStaticMarkup(createElement(PiLiveCurrentTaskRound, {
    model: runningRound,
    items: [
      { id: 'thinking', kind: 'thinking', text: '检查文件后继续执行。', at: '', state: 'running' },
      { id: 'running-tool', kind: 'tool', callId: 'running-tool', name: 'bash', status: 'running', summary: 'npm test', output: 'line 1\nline 2', at: '' },
    ],
    pendingMessageCount: 0,
  }))
  assert.match(html, /处理详情/)
  assert.match(html, /1 条消息/)
  assert.match(html, /1 次工具调用/)
  assert.match(html, /data-task-thinking-state="running"/)
  assert.match(html, /处理中/)
  assert.doesNotMatch(html, /data-status="running"/)
  assert.doesNotMatch(html, /data-tool-fact="true"/)
  assert.doesNotMatch(html, /line 1/)
  assert.doesNotMatch(html, /<details[^>]*data-task-tool-group/)
})

test('Pi settled 处理详情默认折叠并隐藏 Tool 正文', () => {
  const html = renderToStaticMarkup(createElement(PiLiveCurrentTaskRound, {
    model: { ...runningRound, state: 'settled', durationMs: 138_000 },
    items: [{ id: 'success-tool', kind: 'tool', callId: 'success-tool', name: 'read_file', status: 'success', summary: 'very/long/path/to/source.ts', output: 'file content', at: '' }],
    pendingMessageCount: 0,
  }))
  assert.match(html, /处理详情/)
  assert.match(html, /1 次工具调用/)
  assert.match(html, /耗时 2分18秒/)
  assert.doesNotMatch(html, /data-status="success"/)
  assert.doesNotMatch(html, /very\/long\/path\/to\/source\.ts/)
})

test('Pi settled 失败 Tool 默认收进处理详情且摘要保留失败数', () => {
  const html = renderToStaticMarkup(createElement(PiLiveCurrentTaskRound, {
    model: { ...runningRound, state: 'settled', errorCount: 1 },
    items: [{ id: 'error-tool', kind: 'tool', callId: 'error-tool', name: 'npm test', status: 'error', summary: 'web tests', output: '1 assertion failed', at: '' }],
    pendingMessageCount: 0,
  }))
  assert.match(html, /处理详情/)
  assert.match(html, /1 次工具调用/)
  assert.match(html, /1 次失败/)
  assert.doesNotMatch(html, /data-status="error"/)
  assert.doesNotMatch(html, /1 assertion failed/)
})

test('assistant controls have no invisible status spacer after streaming settles', () => {
  const html = renderToStaticMarkup(createElement(TaskMessage, { role: 'assistant', text: 'rendered answer', collapsible: false }))
  assert.doesNotMatch(html, /task-message-output-state/)
  assert.match(html, /task-message-copy-action/)
  assert.match(html, />源码</)
})

test('thinking title uses a measured duration only and does not masquerade as execution time', () => {
  const html = renderToStaticMarkup(createElement(TaskThinking, {
    model: { id: 'reasoning', label: '思考过程', text: 'work', durationMs: 83_000, state: 'settled' },
    defaultExpanded: false,
    children: 'work',
  }))
  assert.match(html, /思考了 1分23秒/)
  assert.match(html, /task-thinking-kind-mark/)
  const unknown = renderToStaticMarkup(createElement(TaskThinking, {
    model: { id: 'reasoning-unknown', label: '思考过程', text: 'work' },
    defaultExpanded: false, children: 'work',
  }))
  assert.match(unknown, /思考过程/)
  assert.doesNotMatch(unknown, /思考了/)
})

test('MCP 完整入参与出参位于同一个默认折叠的 Tool 内，不被再次套娃', () => {
  const input = JSON.stringify({ database: 'auth-center-v3', sql: 'SELECT * FROM organization WHERE ancestors LIKE ?', args: ['%sample%'] })
  const data: TaskToolGroupModel = { ...toolGroup, tools: [
    { id: 'mcp', name: 'dbx_execute_query', kind: 'mcp', kindLabel: 'MCP', status: 'success', primary: input.slice(0, 30), rawInput: input, output: '{"rows":[{"id":1}]}' },
  ], itemCount: 1 }
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: data }))
  assert.match(html, /<details class="task-tool-call/)
  assert.doesNotMatch(html, /<details class="task-tool-call[^>]*open=""/)
  assert.match(html, /data-tool-section="input"/)
  assert.match(html, /data-tool-section="output"/)
  assert.doesNotMatch(html, /task-tool-input-details|task-tool-output-details/)
  assert.match(html, /organization WHERE ancestors LIKE/)
  assert.match(html, /rows/)
})
