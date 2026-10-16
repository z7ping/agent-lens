import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../components/workspace-sidebar.css', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../shell-responsive.css', import.meta.url), 'utf8')
const taskCss = readFileSync(new URL('../task-center.css', import.meta.url), 'utf8')
const zhTask = readFileSync(new URL('../i18n/zh-CN/task.ts', import.meta.url), 'utf8')
const page = readFileSync(new URL('./TaskCenterPage.tsx', import.meta.url), 'utf8')
const review = readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8')

test('侧栏只在 Task Center 桌面态扩展，其他工作区、窄屏和 40px 折叠态不变', () => {
  assert.match(app, /onReview \? 'is-task-center' : ''/)
  assert.match(css, /@media \(min-width: 1200px\)[\s\S]*?\.app-shell\.is-task-center:not\(\.is-sidebar-collapsed\)\s*\{\s*grid-template-columns: 340px minmax\(0, 1fr\)/)
  assert.match(css, /@media \(min-width: 992px\) and \(max-width: 1199\.98px\)[\s\S]*?\.app-shell\.is-task-center:not\(\.is-sidebar-collapsed\)\s*\{\s*grid-template-columns: 300px minmax\(0, 1fr\)/)
  assert.match(css, /\.app-shell\.is-sidebar-collapsed\s*\{\s*grid-template-columns: 40px minmax\(0, 1fr\)/)
  assert.match(shell, /@media \(max-width: 767\.98px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/)
})

test('会话列表展示最近观测并保留真实创建时间，绝不当成同一个时间字段', () => {
  assert.match(page, /sessionTimeFact\(item\.startedAt, item\.endedAt\)/)
  assert.match(page, /center\.time\.startedAt/)
  assert.match(page, /center\.time\.lastActivityAt/)
  assert.match(page, /center\.time\.onlyStartedAt/)
  assert.match(page, /<time dateTime=\{moment\?\.at\} title=\{timeTooltip \|\| undefined\}/)
  assert.match(page, /window\.setInterval\(refreshClock, 60_000\)/)
  assert.match(page, /document\.addEventListener\('visibilitychange', refreshClock\)/)
  assert.match(page, /taskDayGroup\(item\.at, now\)/)
})

test('Review 的创建时间与最后观测独立显示，避免缺失结束时间导致创建时间消失', () => {
  assert.match(review, /infoItems=\{taskDetailModel \? \[/)
  assert.match(review, /taskDetailModel\.startedAt && Number\.isFinite\(Date\.parse\(taskDetailModel\.startedAt\)\)/)
  assert.match(review, /taskDetailModel\.endedAt && Number\.isFinite\(Date\.parse\(taskDetailModel\.endedAt\)\)/)
})

test('会话标题负责自适应省略', () => {
  assert.match(taskCss, /\.task-center-rail \.session-item-title-row \.session-item-title \{ min-width: 0; flex: 1 1 auto; \}/)
  assert.doesNotMatch(taskCss, /max-width:\s*74px/)
})

test('任务中心单条会话标题可展示两行，审查状态位于辅助信息层', () => {
  const history = page.slice(page.indexOf('function HistoryTaskItem('), page.indexOf('function RemoteTaskItem('))
  const titleRow = history.slice(history.indexOf('<div className="session-item-title-row">'), history.indexOf('<div className="session-item-meta">'))
  assert.doesNotMatch(titleRow, /StatusBadge/)
  assert.match(history, /<span className="session-item-activity-label"/)
  assert.doesNotMatch(history, /<div className="session-item-activity">/)
  assert.match(history, /item\.hasErrors && <span className="session-item-error"/)
  assert.match(history, /<span className="session-item-meta-separator" aria-hidden="true">·<\/span>/)
  assert.match(history, /<time dateTime=\{moment\?\.at\} title=\{timeTooltip \|\| undefined\}/)
  assert.match(taskCss, /\.task-center-rail \.session-item-title \{[^}]*-webkit-line-clamp: 2;/)
  assert.doesNotMatch(taskCss, /\.task-center-rail \.session-item-activity \{/)
  assert.match(taskCss, /\.task-center-rail \.session-item-meta \.session-item-activity-label \{/)
  assert.match(taskCss, /\.task-center-rail \.session-item:focus-visible \{/)
  assert.match(taskCss, /\.task-center-rail \.session-item-error \{/)
  assert.match(taskCss, /\.task-center-rail \.session-item-active::before \{/)
})

test('Guardian 徽标保留来源原生事实并解释为内部审查，而不是 AgentLens 检查结论', () => {
  assert.match(page, /item\.sessionActivity === 'internal-review' \? t\('center\.presentation\.internalReviewHint'\)/)
  assert.match(zhTask, /internalReviewHint: '由来源智能体标记的内部审查会话，不代表 AgentLens 审查发现了问题。'/)
})

test('历史会话保留无外框分隔线列表和选中/悬停状态', () => {
  assert.match(taskCss, /\.task-center-rail \.session-item \{[^}]*border: 0;[^}]*border-bottom: 1px solid[^}]*border-radius: 0;[^}]*background: transparent;/)
  assert.doesNotMatch(taskCss, /\.task-center-rail \.task-center-live-group \.session-item \{/)
  assert.doesNotMatch(taskCss, /\.task-center-rail \.task-center-history-group \.session-item \{/)
  assert.match(taskCss, /\.task-center-rail \.session-item:hover \{/)
  assert.match(taskCss, /\.task-center-rail \.session-item-active::before \{/)
  assert.match(taskCss, /\.task-center-rail \.session-item-active,\s*\.task-center-rail \.session-item-active:hover \{/)
})

test('A → B → A 快速切换按轮次取消旧 RAF，卸载时释放动画和锚点', () => {
  assert.match(page, /const revision = \+\+historyScrollRevisionRef\.current/)
  assert.match(page, /historyScrollRevisionRef\.current !== revision/)
  assert.match(page, /window\.cancelAnimationFrame\(historyScrollFrameRef\.current\)/)
  assert.match(page, /useEffect\(\(\) => \(\) => \{[\s\S]*?historyScrollRevisionRef\.current \+= 1/)
  assert.doesNotMatch(page, /historyScrollTargetRef/)
})

test('会话列表本地/远程均保留两层信息且完整标题键盘可读，筛选不重复改写', () => {
  const local = page.slice(page.indexOf('function HistoryTaskItem('), page.indexOf('function RemoteTaskItem('))
  const remote = page.slice(page.indexOf('function RemoteTaskItem('), page.indexOf('export function TaskCenterPage('))
  assert.match(local, /title=\{displayTitle\} aria-label=/)
  assert.match(remote, /title=\{title\} aria-label=/)
  assert.match(remote, /className="session-item-source hub-session-source remote"/)
  assert.match(local, /session-item-activity-label/)
  assert.doesNotMatch(local, /session-item-activity">/)
  assert.doesNotMatch(remote, /session-item-activity">/)
  assert.match(page, /const hasActiveFilters = review\.filters\.sourceIds !== null \|\| Boolean\(review\.filters\.projectId\)[\s\S]*?\|\| advancedTimeActive \|\| advancedStatusActive/)
  assert.match(page, /task-center-search-panel/)
  assert.match(page, /task-center-quick-filters/)
  assert.match(page, /task-center-active-filter-list/)
})
