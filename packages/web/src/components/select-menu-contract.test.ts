import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const selectSource = readFileSync(new URL('./SelectMenu.tsx', import.meta.url), 'utf8')
const taskCenterSource = readFileSync(new URL('../features/TaskCenterPage.tsx', import.meta.url), 'utf8')
const liveNewTaskSource = readFileSync(new URL('../features/LiveNewTaskPanel.tsx', import.meta.url), 'utf8')
const sidebarStyles = readFileSync(new URL('./workspace-sidebar.css', import.meta.url), 'utf8')

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

test('任务中心智能体/项目/高级筛选共享 32px 控件规格', () => {
  const projectFilter = taskCenterSource.match(/<SelectMenu\s+className="task-center-project-filter"[\s\S]*?\/>/)?.[0]
  assert.ok(projectFilter)
  assert.match(projectFilter, /variant="toolbar"/)
  assert.match(projectFilter, /searchable/)
  assert.match(taskCenterSource, /<SidebarFilterDisclosure\s+className="task-center-agent-filter"/)
  const sharedTriggerRule = sidebarStyles.match(/\.workspace-sidebar-context > \.task-center-rail \.task-center-agent-filter > summary,\s*\.workspace-sidebar-context > \.task-center-rail \.task-center-project-filter\.select-menu-trigger,\s*\.workspace-sidebar-context > \.task-center-rail \.task-center-advanced-filter > summary \{([^}]*)\}/)?.[1]
  assert.ok(sharedTriggerRule, '项目 SelectMenu 和智能体 Disclosure 必须使用同一条视觉契约')
  assert.match(sharedTriggerRule, /height:\s*32px;/)
  assert.match(sharedTriggerRule, /min-height:\s*32px;/)
  assert.match(sharedTriggerRule, /font-size:\s*13px;/)
  assert.match(sharedTriggerRule, /border-radius:\s*8px;/)
  assert.doesNotMatch(sidebarStyles, /\.task-center-project-filter\s+\.select-menu-trigger/)
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

test('SelectMenu 的菜单键盘处理保护 IME，并跟踪 Sidebar 浮层锚点变化', () => {
  assert.match(selectSource, /event\.nativeEvent\.isComposing \|\| event\.nativeEvent\.keyCode === 229/)
  assert.match(selectSource, /event\.target !== searchRef\.current/)
  assert.match(selectSource, /new ResizeObserver\(\(\) =>/)
  assert.match(selectSource, /getComputedStyle\(trigger\)\.visibility === 'hidden'/)
  assert.match(selectSource, /geometryObserver\?\.observe\(triggerRef\.current\)/)
  assert.match(selectSource, /geometryObserver\?\.observe\(sidebar\)/)
  assert.match(selectSource, /geometryObserver\?\.disconnect\(\)/)
})

test('任务中心多选由「全部」进入单项、复选累计；高级筛选不再嵌套 SelectMenu', () => {
  const agentSource = readFileSync(new URL('./SidebarFilterDisclosure.tsx', import.meta.url), 'utf8')
  const advanced = taskCenterSource.slice(taskCenterSource.indexOf('className="task-center-advanced-filter"'))
  assert.match(taskCenterSource, /multipleSelectionBehavior="pick-from-all"/)
  assert.match(agentSource, /nextAgentFilterSelection\(agentSelection\.value, sourceId, detectedIds\)/)
  assert.match(agentSource, /<UiIcon name="check" size=\{14\} aria-hidden="true"\/>/)
  assert.match(advanced, /task-center-advanced-filter-panel/)
  assert.match(advanced, /className="task-center-advanced-filter-options"/)
  assert.match(advanced, /aria-pressed=\{review\.filters\.range === option\.value\}/)
  assert.match(advanced, /aria-pressed=\{review\.filters\.status === option\.value\}/)
  assert.doesNotMatch(advanced.split('</SidebarFilterDisclosure>')[0], /<SelectMenu/)
})

test('任务中心高级筛选的展示和清除行为与筛选条件一致', () => {
  assert.match(taskCenterSource, /advancedTimeActive = review\.filters\.range !== '7d'/)
  assert.match(taskCenterSource, /advancedStatusActive = review\.filters\.status !== 'all'/)
  assert.match(taskCenterSource, /className="task-center-filter-chip" onClick=\{\(\) => model\.setReviewFilters\(\{ range: '7d' \}\)\}/)
  assert.match(taskCenterSource, /className="task-center-filter-chip" onClick=\{\(\) => model\.setReviewFilters\(\{ status: 'all' \}\)\}/)
  assert.match(taskCenterSource, /clearAllFilters = \(\) => model\.setReviewFilters\(\{ sourceIds: null, projectId: '', range: '7d', status: 'all', search: '' \}\)/)
  assert.match(taskCenterSource, /remoteFilterLimitation/)
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
