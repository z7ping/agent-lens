import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskToolGroup } from './TaskToolGroup'
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
    { id: 'shell-1', name: '执行命令', kind: 'shell', kindLabel: 'Shell', status: 'success', primary: 'pnpm test', durationLabel: '38s' },
  ],
}

function render(defaultExpanded?: boolean): string {
  return renderToStaticMarkup(createElement(TaskToolGroup, defaultExpanded === undefined ? { model } : { model, defaultExpanded }))
}

test('TaskToolGroup 不再创建“工具执行”折叠父层，具体调用直接可见', () => {
  const html = render()
  assert.match(html, /data-task-tool-group="true"/)
  assert.doesNotMatch(html, /<details[^>]*data-task-tool-group/)
  assert.doesNotMatch(html, />工具执行</)
  assert.equal((html.match(/data-tool-fact="true"/g) ?? []).length, 3)
  assert.equal((html.match(/class="task-tool-row"/g) ?? []).length, 3)
  assert.doesNotMatch(html, /execution-row|tool-row(?!-)|execution-group|tool-group|agent-lane-node/)
  assert.match(html, /读取文件/)
  assert.match(html, /src\/review\.ts/)
  assert.match(html, /完成 · 42ms/)
  assert.match(html, /代码搜索/)
  assert.match(html, /TaskToolGroup/)
  assert.match(html, /执行命令/)
  assert.match(html, /pnpm test/)
})

test('Tool 是否折叠由真实父级控制，defaultExpanded 不再制造独立层级', () => {
  const expanded = render(true)
  const collapsed = render(false)
  assert.doesNotMatch(expanded, /<details[^>]*data-task-tool-group/)
  assert.doesNotMatch(collapsed, /<details[^>]*data-task-tool-group/)
  assert.equal((collapsed.match(/data-tool-fact="true"/g) ?? []).length, 3)
})

test('工具类型后紧跟状态和耗时，再展示动作与目标', () => {
  const html = render()
  const kind = html.indexOf('>读取</span>')
  const status = html.indexOf('完成 · 42ms')
  const action = html.indexOf('读取文件')
  const target = html.indexOf('src/review.ts')
  assert.ok(kind >= 0 && status > kind && action > status && target > action)
})

test('错误 Tool Call 仍以具体行出现并保留错误语义', () => {
  const errorModel: TaskToolGroupModel = {
    ...model,
    itemCount: 1,
    errorCount: 1,
    kindCounts: [{ kind: 'shell', label: 'Shell', count: 1 }],
    tools: [{ id: 'shell-error', name: '运行测试', kind: 'shell', kindLabel: 'Shell', status: 'error', primary: 'pnpm test', durationLabel: '1.2s' }],
  }
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: errorModel }))
  assert.match(html, /task-tool-row task-tool-row-error/)
  assert.match(html, /运行测试/)
  assert.match(html, /失败 · 1\.2s/)
})
