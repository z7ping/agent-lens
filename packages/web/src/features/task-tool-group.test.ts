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
    { kind: 'shell', label: '命令', count: 1 },
  ],
  tools: [
    { id: 'read-1', name: '读取文件', kind: 'read', kindLabel: '读取', status: 'success', primary: 'src/review.ts', durationLabel: '42ms' },
    { id: 'search-1', name: '代码搜索', kind: 'search', kindLabel: '搜索', status: 'success', primary: 'TaskToolGroup', durationLabel: '51ms' },
    { id: 'shell-1', name: '执行命令', kind: 'shell', kindLabel: '命令', status: 'success', primary: 'pnpm test', durationLabel: '38s' },
  ],
}

function render(defaultExpanded?: boolean): string {
  return renderToStaticMarkup(createElement(TaskToolGroup, defaultExpanded === undefined ? { model } : { model, defaultExpanded }))
}

test('TaskToolGroup 默认展开并保留每一次具体 Tool Call', () => {
  const html = render()
  assert.match(html, /<details[^>]*open=""/)
  assert.match(html, /工具执行/)
  assert.match(html, /读取 → 搜索 → 命令/)
  assert.equal((html.match(/task-tool-row execution-row tool-row/g) ?? []).length, 3)
  assert.match(html, /读取文件/)
  assert.match(html, /src\/review\.ts/)
  assert.match(html, /完成 · 42ms/)
  assert.match(html, /代码搜索/)
  assert.match(html, /TaskToolGroup/)
  assert.match(html, /执行命令/)
  assert.match(html, /pnpm test/)
})

test('用户主动折叠 Tool Group 时只改变 details 状态，不把具体调用替换为汇总数据', () => {
  const html = render(false)
  assert.doesNotMatch(html, /<details[^>]*open=""/)
  assert.equal((html.match(/task-tool-row execution-row tool-row/g) ?? []).length, 3)
  assert.match(html, /读取文件/)
  assert.match(html, /代码搜索/)
  assert.match(html, /执行命令/)
})

test('错误 Tool Call 仍以具体行出现并保留错误语义', () => {
  const errorModel: TaskToolGroupModel = {
    ...model,
    itemCount: 1,
    errorCount: 1,
    kindCounts: [{ kind: 'shell', label: '命令', count: 1 }],
    tools: [{ id: 'shell-error', name: '运行测试', kind: 'shell', kindLabel: '命令', status: 'error', primary: 'pnpm test', durationLabel: '1.2s' }],
  }
  const html = renderToStaticMarkup(createElement(TaskToolGroup, { model: errorModel }))
  assert.match(html, /task-tool-row execution-row tool-row error/)
  assert.match(html, /运行测试/)
  assert.match(html, /失败 · 1\.2s/)
})
