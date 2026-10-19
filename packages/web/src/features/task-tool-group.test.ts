import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskToolGroup, visibleTaskToolIds, type TaskToolGroupSequenceEntry } from './TaskToolGroup'
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

test('工具摘要保留类型、状态与箭头，Shell 命令通过独立预览保持可见', () => {
  const html = render()
  assert.match(html, /<summary class="task-tool-row"/)
  assert.match(html, /class="task-tool-kind task-tool-kind-shell"/)
  assert.match(html, /class="task-tool-summary-text" title="执行命令">执行命令<\/span>/)
  assert.match(html, /<code class="task-tool-command-preview" title="pnpm test">pnpm test<\/code>/)
  assert.match(html, /task-tool-row-chevron/)
  assert.doesNotMatch(html, /class="task-tool-command"/)
  assert.match(html, /class="task-tool-target"/)
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

test('连续大量工具仅展示前三项及所有失败、运行中工具，保持原生顺序', () => {
  const tools = Array.from({ length: 9 }, (_, index) => ({
    ...model.tools[0]!,
    id: `tool-${index + 1}`,
    name: `native-${index + 1}`,
    status: index === 5 || index === 8 ? 'running' as const
      : index === 7 ? 'error' as const : 'success' as const,
  }))
  assert.deepEqual([...visibleTaskToolIds(tools, false)], [
    'tool-1', 'tool-2', 'tool-3', 'tool-6', 'tool-8', 'tool-9',
  ])
  const group = { ...model, id: 'batch:9', tools, itemCount: tools.length, errorCount: 1 }
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: group, compact: true }))
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /工具调用 · 9 项/)
  assert.match(html, /展开其余 3 项/)
  assert.match(html, /1 失败/)
  assert.match(html, /2 运行中/)
  assert.equal((html.match(/data-tool-fact="true"/g) ?? []).length, 6)
  assert.doesNotMatch(html, /native-4|native-5|native-7/)
  assert.doesNotMatch(html, /<details[^>]*data-task-tool-group/)
  let previous = -1
  for (const name of ['native-1', 'native-2', 'native-3', 'native-6', 'native-8', 'native-9']) {
    const position = html.indexOf(name, previous + 1)
    assert.ok(position > previous, `tool out of order: ${name}`)
    previous = position
  }
  const all = renderToStaticMarkup(createElement(TaskToolGroup, { model: group, defaultExpanded: true, compact: true }))
  assert.match(all, /aria-expanded="true"/)
  assert.equal((all.match(/data-tool-fact="true"/g) ?? []).length, 9)
  assert.ok(all.indexOf('native-4') < all.indexOf('native-5'))
  assert.ok(all.indexOf('native-7') < all.indexOf('native-8'))
})

test('三条以下不出现批次折叠；全部异常时不产生空操作', () => {
  assert.doesNotMatch(render(), /task-tool-group-toggle/)
  const tools = Array.from({ length: 5 }, (_, index) => ({
    ...model.tools[0]!, id: `error-${index}`, status: 'error' as const,
  }))
  const html = renderToStaticMarkup(createElement(TaskToolGroup, {
    model: { ...model, id: 'all-errors', tools, itemCount: tools.length },
    compact: true,
  }))
  assert.doesNotMatch(html, /task-tool-group-toggle/)
  assert.equal((html.match(/data-tool-fact="true"/g) ?? []).length, 5)
})

test('一轮内思考/消息穿插不重置前三项预算，失败与执行中继续可见', () => {
  const tools = Array.from({ length: 8 }, (_, index) => ({
    ...model.tools[0]!,
    id: `interleaved-${index + 1}`,
    name: `native_${index + 1}`,
    status: index === 5 ? 'error' as const
      : index === 7 ? 'running' as const : 'success' as const,
  }))
  const sequence: TaskToolGroupSequenceEntry[] = tools.flatMap((tool, index) => [
    { type: 'tool' as const, key: tool.id, tool },
    ...(index === 1 ? [{ type: 'content' as const, key: 'thought', content: '思考分隔事件' }] : []),
    ...(index === 4 ? [{ type: 'content' as const, key: 'commentary', content: '执行说明内容' }] : []),
  ])
  const props = {
    model: { ...model, id: 'round-with-messages', tools, itemCount: 8, errorCount: 1 },
    sequence,
    compact: true,
  }
  const html = renderToStaticMarkup(createElement(TaskToolGroup, props))
  assert.match(html, /工具调用 · 8 项/)
  assert.match(html, /展开其余 3 项/)
  assert.equal((html.match(/data-tool-fact="true"/g) ?? []).length, 5)
  assert.match(html, /思考分隔事件/)
  assert.match(html, /执行说明内容/)
  assert.doesNotMatch(html, /native_4|native_5|native_7/)
  const expected = ['native_1', 'native_2', '思考分隔事件', 'native_3', '执行说明内容', 'native_6', 'native_8']
  // Hidden ordinary calls leave gaps, but retained items never change order.
  let last = -1
  for (const token of expected) {
    const next = html.indexOf(token, last + 1)
    assert.ok(next > last, `unexpected order or missing: ${token}`)
    last = next
  }
  const expanded = renderToStaticMarkup(createElement(TaskToolGroup, { ...props, defaultExpanded: true }))
  assert.equal((expanded.match(/data-tool-fact="true"/g) ?? []).length, 8)
  assert.ok(expanded.indexOf('native_4') < expanded.indexOf('执行说明内容'))
})
