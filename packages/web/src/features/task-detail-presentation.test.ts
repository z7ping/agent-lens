import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PiLiveRunningTaskRound } from './PiLiveTaskRound'
import { TaskMessage } from './TaskMessage'
import { TaskRound } from './TaskRound'
import { TaskToolGroup } from './TaskToolGroup'
import type { TaskRoundModel, TaskToolGroupModel } from './task-detail-model'

const toolGroup: TaskToolGroupModel = {
  id: 'tools:test', label: '工具执行', itemCount: 4, errorCount: 0, kindCounts: [],
  tools: [
    { id: 'read', name: '读取文件', kind: 'read', kindLabel: '读取', status: 'success', primary: 'packages/web/src/App.tsx', durationMs: 42 },
    { id: 'search', name: '代码搜索', kind: 'search', kindLabel: '搜索', status: 'success', primary: 'startedAt / capturedAt', durationMs: 51 },
    { id: 'test', name: 'npm test', kind: 'tool', kindLabel: '工具', status: 'success', primary: 'packages/web', durationMs: 830 },
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
  assert.match(html, /data-kind="test"/)
  assert.match(html, /task-tool-kind-test/)
  assert.match(html, />测试</)
  assert.match(html, /data-kind="tool"/)
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
  const assistant = renderToStaticMarkup(createElement(TaskMessage, { role: 'assistant', text: '智能体回复', collapsible: false }))
  assert.match(user, /task-message-row task-message-user/)
  assert.match(user, /task-message-bubble-user/)
  assert.doesNotMatch(user, />源码</)
  assert.match(assistant, /task-message-row task-message-assistant/)
  assert.match(assistant, /task-message-bubble-assistant/)
  assert.match(assistant, />源码</)
  assert.doesNotMatch(user, /class="(?:message-row|chat-bubble)(?:\s|\")/)
  assert.doesNotMatch(assistant, /class="(?:message-row|chat-bubble)(?:\s|\")/)
})

test('工具状态和耗时紧跟工具类型，而不是放到最右侧', () => {
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: toolGroup }))
  const kind = html.indexOf('>读取</span>')
  const status = html.indexOf('完成 · 42ms')
  const action = html.indexOf('读取文件')
  const target = html.indexOf('packages/web/src/App.tsx')
  assert.ok(kind >= 0 && status > kind && action > status && target > action)
})

test('Pi Running Tool 直接展示事实行，并在行下展示有限高度实时输出', () => {
  const html = renderToStaticMarkup(createElement(PiLiveRunningTaskRound, { model: runningRound, thinkingText: '检查文件后继续执行。', tools: [{ id: 'running-tool', name: 'bash', status: 'running', summary: 'npm test', output: 'line 1\nline 2' }], streamText: '', isStreaming: true, pendingMessageCount: 0 }))
  assert.match(html, /data-status="running"/)
  assert.match(html, /data-tool-fact="true"/)
  assert.match(html, /class="task-tool-live-output"/)
  assert.match(html, /line 1/)
  assert.match(html, /data-task-tool-group="true"/)
  assert.doesNotMatch(html, /<details[^>]*data-task-tool-group/)
})

test('Pi settled 成功输出折叠在 Tool Call 事实行之下', () => {
  const html = renderToStaticMarkup(createElement(PiLiveRunningTaskRound, { model: { ...runningRound, state: 'settled' }, thinkingText: '', tools: [{ id: 'success-tool', name: 'read_file', status: 'success', summary: 'very/long/path/to/source.ts', output: 'file content' }], streamText: '', isStreaming: false, pendingMessageCount: 0 }))
  assert.match(html, /data-status="success"/)
  assert.match(html, /very\/long\/path\/to\/source\.ts/)
  assert.match(html, /class="task-tool-output-details"/)
  assert.doesNotMatch(html, /class="task-tool-output-details"[^>]*open=""/)
})

test('Pi Running 失败 Tool 保留事实行并默认展开错误输出', () => {
  const html = renderToStaticMarkup(createElement(PiLiveRunningTaskRound, { model: { ...runningRound, state: 'settled', errorCount: 1 }, thinkingText: '', tools: [{ id: 'error-tool', name: 'npm test', status: 'error', summary: 'web tests', output: '1 assertion failed' }], streamText: '', isStreaming: false, pendingMessageCount: 0 }))
  assert.match(html, /data-status="error"/)
  assert.match(html, /data-kind="test"/)
  assert.match(html, /class="task-tool-output-details"[^>]*open=""|open=""[^>]*class="task-tool-output-details"/)
  assert.match(html, /1 assertion failed/)
})
