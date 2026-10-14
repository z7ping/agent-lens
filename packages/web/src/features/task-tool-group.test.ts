import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskToolGroup } from './TaskToolGroup'
import { taskToolTargetText } from './TaskToolRow'
import type { TaskToolGroupModel } from './task-detail-model'

const model: TaskToolGroupModel = {
  id: 'tools:test',
  label: '工具执行',
  itemCount: 3,
  errorCount: 0,
  kindCounts: [
    { kind: 'read', label: '读取', count: 1 },
    { kind: 'search', label: '搜索', count: 1 },
    { kind: 'shell', label: 'Shell', count: 1 },
  ],
  tools: [
    { id: 'read-1', name: '读取文件', kind: 'read', kindLabel: '读取', status: 'success', primary: 'src/review.ts', durationLabel: '42ms' },
    { id: 'search-1', name: '代码搜索', kind: 'search', kindLabel: '搜索', status: 'success', primary: 'TaskToolGroup', durationLabel: '51ms' },
    { id: 'shell-1', name: '执行命令', kind: 'shell', kindLabel: 'Shell', status: 'success', primary: 'pnpm test', rawInput: '{"command":"pnpm test"}', output: 'passed 42 tests', durationLabel: '38s' },
  ],
}

function render(defaultExpanded?: boolean): string {
  return renderToStaticMarkup(createElement(TaskToolGroup, defaultExpanded === undefined ? { model } : { model, defaultExpanded }))
}

test('每次 Tool Call 独立默认收起，Group 不额外折叠，原生顺序不变', () => {
  const html = render()
  assert.match(html, /data-task-tool-group="true"/)
  assert.doesNotMatch(html, /<details[^>]*data-task-tool-group/)
  assert.equal((html.match(/<details class="task-tool-call/g) ?? []).length, 3)
  assert.equal((html.match(/data-tool-fact="true"/g) ?? []).length, 3)
  assert.doesNotMatch(html, /<details class="task-tool-call[^>]* open=/)
  assert.ok(html.indexOf('读取文件') < html.indexOf('代码搜索'))
  assert.ok(html.indexOf('代码搜索') < html.indexOf('pnpm test'))
})

test('默认摘要只有单行：工具图标、类型、简短目标、状态图标及展开箭头', () => {
  const html = render()
  assert.match(html, /<summary class="task-tool-row"/)
  assert.match(html, /class="task-tool-kind task-tool-kind-shell"/)
  assert.match(html, /class="task-tool-summary-text" title="pnpm test">pnpm test<\/span>/)
  assert.match(html, /task-tool-row-chevron/)
  assert.doesNotMatch(html, /class="task-tool-command"/)
  assert.doesNotMatch(html, /class="task-tool-target"/)
  assert.doesNotMatch(html, /class="task-tool-action"/)
  assert.match(html, /class="task-tool-status-mark"/)
})

test('展开后入参和出参是两个平级区域，原始数据可复制，错误也不自动展开', () => {
  const html = render()
  assert.match(html, /data-tool-section="input"[^>]*aria-label="入参"/)
  assert.match(html, /data-tool-section="output"[^>]*aria-label="出参"/)
  assert.match(html, /\{&quot;command&quot;:&quot;pnpm test&quot;\}/)
  assert.match(html, /passed 42 tests/)
  assert.doesNotMatch(html, /task-tool-input-details/)
  assert.doesNotMatch(html, /task-tool-output-details/)
  const error: TaskToolGroupModel = {
    ...model,
    tools: [{ id: 'error', name: 'bash', kind: 'shell', kindLabel: 'Shell', status: 'error', rawInput: '{"command":"exit 1"}', output: 'Exit code: 1' }],
  }
  const rendered = renderToStaticMarkup(createElement(TaskToolGroup, { model: error }))
  assert.match(rendered, /class="task-tool-call task-tool-row-error"/)
  assert.doesNotMatch(rendered, /<details[^>]*open=""/)
  assert.match(rendered, /Exit code: 1/)
})

test('缺少原始入参时，摘要不能冒充真实入参；缺少出参不伪造结果', () => {
  const html = render()
  assert.match(html, /调用摘要（原始入参未记录）/)
  assert.match(html, /src\/review\.ts/)
  assert.match(html, /未记录出参/)
})

test('Shell JSON 输入仍提取命令作单行预览，但展开保留原始 JSON', () => {
  assert.equal(taskToolTargetText({
    id: 'shell-json', name: 'bash', kind: 'shell', kindLabel: 'Shell', status: 'success', primary: '{"command":"git status"}',
  }, 'shell'), 'git status')
})

test('没有状态结果时用中性状态，不按名称猜工具类型', () => {
  const unknown: TaskToolGroupModel = {
    ...model, tools: [
      { id: 'mcp', name: 'dbx_execute_query', kind: 'mcp', kindLabel: 'MCP', status: 'success', rawInput: '{"sql":"select 1"}', output: '{"rows":[1]}' },
      { id: 'unknown', name: 'npm test', kind: 'tool', kindLabel: '工具', status: 'unknown' },
    ],
  }
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: unknown }))
  assert.match(html, /data-kind="mcp"/)
  assert.match(html, /data-kind="tool"/)
  assert.doesNotMatch(html, /data-kind="test"/)
  assert.match(html, /select 1/)
  assert.match(html, /rows/)
})

test('Review Inspector 保留为展开面板内的明确操作按钮，不劫持折叠点击', () => {
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model, onToolClick: () => {} }))
  assert.match(html, /<button[^>]*class="task-tool-inspect"/)
  assert.match(html, /查看原始证据/)
  assert.doesNotMatch(html, /<button[^>]*class="task-tool-row"/)
})

test('成功绿色、失败红色且状态标记无额外圆框', () => {
  const success = render()
  assert.match(success, /data-status="success"/)
  assert.match(success, /task-tool-status-ok/)
  const failed = renderToStaticMarkup(createElement(TaskToolGroup, { model: {
    ...model, itemCount: 1, errorCount: 1,
    tools: [{ id: 'bad', name: 'bash', kind: 'shell', kindLabel: 'Shell', status: 'error', rawInput: '{"command":"exit 1"}', output: 'exit=1' }],
  } }))
  assert.match(failed, /data-status="error"/)
  assert.match(failed, /task-tool-status-error/)
  assert.doesNotMatch(failed, /lucide-circle-x|lucide-circle-check/)
  // Tool rows tokenize large payloads only after the user expands one call.
  assert.doesNotMatch(failed, /data-code-language="json"/)
  assert.match(failed, /data-tool-section="input"/)
  assert.match(failed, /data-tool-section="output"/)
})
