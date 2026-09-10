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

test('新建 Pi 任务使用聚焦启动卡片并提供已有项目与目录启动入口', () => {
  assert.match(taskCenterSource, /className="task-center-new-card"/)
  assert.match(taskCenterSource, /新建 Pi 任务/)
  assert.match(taskCenterSource, /选择目录新建并打开 <UiIcon name="arrow-right" size=\{14\}/)
  assert.match(taskCenterSource, /打开已有项目 <UiIcon name="arrow-right" size=\{14\}/)
  assert.match(taskCenterSource, /mode === 'new' \? 'is-new-task' : ''/)
  assert.doesNotMatch(taskCenterSource, /task-center-agent-fixed/)
})


test('已有项目下拉支持服务端搜索和继续加载，同时 SelectMenu 其他调用保持可选增强', () => {
  assert.match(selectSource, /onSearchChange\?: \(value: string\) => void/)
  assert.match(selectSource, /onLoadMore\?: \(\) => void/)
  assert.match(selectSource, /className="select-menu-footer"/)
  assert.match(taskCenterSource, /onSearchChange=\{onProjectSearch\}/)
  assert.match(taskCenterSource, /onLoadMore=\{onProjectLoadMore\}/)
  assert.match(taskCenterSource, /loadMoreLabel="加载更多项目"/)
})
