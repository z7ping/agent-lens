import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const selectSource = readFileSync(new URL('./SelectMenu.tsx', import.meta.url), 'utf8')
const taskCenterSource = readFileSync(new URL('../features/TaskCenterPage.tsx', import.meta.url), 'utf8')
const liveNewTaskSource = readFileSync(new URL('../features/LiveNewTaskPanel.tsx', import.meta.url), 'utf8')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.tsx') ? [path] : []
  })
}

test('Web 下拉入口统一使用 SelectMenu，而不是页面级原生 select', () => {
  const nativeSelectOwners = sourceFiles(sourceRoot).filter(path => /<select(?:\s|>)/.test(readFileSync(path, 'utf8')))
  assert.deepEqual(nativeSelectOwners, [])
  assert.match(liveNewTaskSource, /<SelectMenu[\s\S]*?variant="field"[\s\S]*?searchable/)
})

test('SelectMenu 提供键盘、搜索、选中态与窗口安全定位', () => {
  assert.match(selectSource, /aria-haspopup="listbox"/)
  assert.match(selectSource, /aria-activedescendant=/)
  assert.match(selectSource, /event\.key === 'Escape'/)
  assert.match(selectSource, /event\.key === 'Home' \|\| event\.key === 'End'/)
  assert.match(selectSource, /event\.key === 'Enter' \|\| \(!searchable && event\.key === ' '\)/)
  assert.match(selectSource, /searchable && <div className="select-menu-search-wrap">/)
  assert.match(selectSource, /createPortal\(/)
})

test('SelectMenu 浮层阻止 pointerdown 冒泡，避免嵌套弹层在选择前被关闭', () => {
  assert.match(selectSource, /onPointerDown=\{event => event\.stopPropagation\(\)\}/)
})

test('SelectMenu 非搜索模式把真实 listbox 作为键盘焦点 Owner', () => {
  assert.match(selectSource, /const listboxRef = useRef<HTMLDivElement>\(null\)/)
  assert.match(selectSource, /\(searchable \? searchRef\.current : listboxRef\.current\)\?\.focus/)
  assert.match(selectSource, /<div ref=\{listboxRef\} id=\{listboxId\}[\s\S]*?role="listbox"[\s\S]*?tabIndex=\{searchable \? undefined : -1\}/)
  assert.doesNotMatch(selectSource, /\(searchable \? searchRef\.current : menuRef\.current\)\?\.focus/)
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
  assert.match(liveNewTaskSource, /className="task-center-new-card"/)
  assert.match(liveNewTaskSource, /t\('center\.newTask\.title'\)/)
  assert.match(liveNewTaskSource, /const \[launchMode, setLaunchMode\] = useState<'existing' \| 'directory'>\('existing'\)/)
  assert.match(liveNewTaskSource, /role="radiogroup" aria-label=\{t\('center\.newTask\.launchModeAria'\)\}/)
  assert.match(liveNewTaskSource, /aria-checked=\{launchMode === 'existing'\}/)
  assert.match(liveNewTaskSource, /aria-checked=\{launchMode === 'directory'\}/)
  assert.match(liveNewTaskSource, /launchMode === 'existing'/)
  assert.match(liveNewTaskSource, /t\('center\.newTask\.selectDirectory'\)[\s\S]*?<UiIcon name="arrow-right" size=\{14\}/)
  assert.match(liveNewTaskSource, /t\('center\.newTask\.openExisting'\)[\s\S]*?<UiIcon name="arrow-right" size=\{14\}/)
  assert.match(taskCenterSource, /mode === 'new' \? 'is-new-task' : ''/)
  assert.doesNotMatch(taskCenterSource, /task-center-agent-fixed/)
})


test('已有项目下拉支持服务端搜索和继续加载，同时 SelectMenu 其他调用保持可选增强', () => {
  assert.match(selectSource, /onSearchChange\?: \(value: string\) => void/)
  assert.match(selectSource, /onLoadMore\?: \(\) => void/)
  assert.match(selectSource, /className="select-menu-footer"/)
  assert.match(liveNewTaskSource, /onSearchChange=\{onProjectSearch\}/)
  assert.match(liveNewTaskSource, /onLoadMore=\{onProjectLoadMore\}/)
  assert.match(liveNewTaskSource, /loadMoreLabel=\{t\('center\.newTask\.loadMoreProjects'\)\}/)
})
