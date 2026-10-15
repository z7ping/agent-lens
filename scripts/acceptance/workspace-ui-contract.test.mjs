import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync('scripts/acceptance/task-center-desktop.mjs', 'utf8')

test('Electron 桌面验收覆盖智能体定位、40px 共享导航与工具可排序表头', () => {
  assert.match(source, /async function inspectWorkspaceUi\(win\)/)
  assert.match(source, /before\.selectedId !== before\.targetAgent/)
  assert.match(source, /after\.view !== 'management' \|\| after\.agent !== before\.selectedId/)
  assert.match(source, /Math\.abs\(after\.tabsHeight - 40\)/)
  assert.match(source, /th\[aria-sort\]/)
  assert.match(source, /button\.tool-table-sort/)
  assert.match(source, /table\.beforeSort === table\.afterSort/)
  assert.match(source, /report\.workspaceUi = await withTimeout\(inspectWorkspaceUi\(win\)/)
})

test('无工具调用表格时报告未验证，不能伪装为真实排序验收', () => {
  assert.match(source, /checked: false, reason: '当前没有工具调用表格数据'/)
  assert.match(source, /if \(table\.checked && /)
})
