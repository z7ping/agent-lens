import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const selectSource = readFileSync(new URL('./SelectMenu.tsx', import.meta.url), 'utf8')
const taskCenterSource = readFileSync(new URL('../features/TaskCenterPage.tsx', import.meta.url), 'utf8')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.tsx') ? [path] : []
  })
}

test('Web 下拉入口统一使用 SelectMenu，而不是页面级原生 select', () => {
  const nativeSelectOwners = sourceFiles(sourceRoot).filter(path => /<select(?:\s|>)/.test(readFileSync(path, 'utf8')))
  assert.deepEqual(nativeSelectOwners.map(path => path.replace(sourceRoot, '').replaceAll('\\', '/').replace(/^\/+/, '')), ['components/ui/Primitives.tsx'])
  assert.match(taskCenterSource, /<SelectMenu[\s\S]*?variant="field"[\s\S]*?searchable/)
})

test('SelectMenu 提供键盘、搜索、选中态与窗口安全定位', () => {
  assert.match(selectSource, /aria-haspopup="listbox"/)
  assert.match(selectSource, /aria-activedescendant=/)
  assert.match(selectSource, /event\.key === 'Escape'/)
  assert.match(selectSource, /event\.key === 'Home' \|\| event\.key === 'End'/)
  assert.match(selectSource, /searchable && <div className="select-menu-search-wrap">/)
  assert.match(selectSource, /createPortal\(/)
})

test('路径型项目选项第一行收敛为项目名，第二行保留路径并提供 tooltip', () => {
  assert.match(selectSource, /export function selectMenuDisplayLabel/)
  assert.match(selectSource, /normalizedPath\(option\.label\) === normalizedPath\(option\.description\)/)
  assert.match(selectSource, /pathBasename\(option\.description\)/)
  assert.match(selectSource, /title=\{selectedTooltip\}/)
  assert.match(selectSource, /title=\{selectMenuTooltip\(option\)\}/)
  assert.match(selectSource, /<b>\{displayLabel\}<\/b>\{option\.description && <small>\{option\.description\}<\/small>\}/)
})

test('新建 Pi 任务使用聚焦启动卡片并移除固定智能体占位', () => {
  assert.match(taskCenterSource, /新建 Pi 任务/)
  assert.match(taskCenterSource, /创建 Pi 任务 <UiIcon name="arrow-right" size=\{14\}/)
  assert.match(taskCenterSource, /mode === 'new' \? 'is-new-task' : ''/)
  assert.doesNotMatch(taskCenterSource, /task-center-agent-fixed/)
})
