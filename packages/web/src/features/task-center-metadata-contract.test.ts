import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../components/workspace-sidebar.css', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../shell-responsive.css', import.meta.url), 'utf8')
const taskCss = readFileSync(new URL('../task-center.css', import.meta.url), 'utf8')
const runtimeList = readFileSync(new URL('./TaskLiveRuntimeList.tsx', import.meta.url), 'utf8')
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

test('进行中/初始化中徽标不被 max-width 74px 裁切，标题负责自适应省略', () => {
  assert.match(runtimeList, /className="task-live-status-badge"/)
  assert.match(runtimeList, /title=\{badge\.label\}/)
  assert.match(taskCss, /\.task-center-rail \.session-item-title-row \.task-live-status-badge \{[^}]*max-width: none;[^}]*min-width: max-content;[^}]*overflow: visible;/)
  assert.match(taskCss, /\.task-center-rail \.session-item-title-row \.session-item-title \{ min-width: 0; flex: 1 1 auto; \}/)
  assert.doesNotMatch(taskCss, /max-width:\s*74px/)
})

test('Guardian 徽标保留来源原生事实并解释为内部审查，而不是 AgentLens 检查结论', () => {
  assert.match(page, /item\.sessionActivity === 'internal-review' \? t\('center\.presentation\.internalReviewHint'\)/)
  assert.match(zhTask, /internalReviewHint: '由来源智能体标记的内部审查会话，不代表 AgentLens 审查发现了问题。'/)
})

test('进行中与历史会话共享无外框分隔线列表，选中/悬停状态仍保留', () => {
  assert.match(taskCss, /\.task-center-rail \.session-item \{[^}]*border: 0;[^}]*border-bottom: 1px solid[^}]*border-radius: 0;[^}]*background: transparent;/)
  assert.doesNotMatch(taskCss, /\.task-center-rail \.task-center-live-group \.session-item \{/)
  assert.doesNotMatch(taskCss, /\.task-center-rail \.task-center-history-group \.session-item \{/)
  assert.match(taskCss, /\.task-center-rail \.session-item:hover \{/)
  assert.match(taskCss, /\.task-center-rail \.session-item-active::before \{/)
  assert.match(taskCss, /\.task-center-rail \.session-item-active,\s*\.task-center-rail \.session-item-active:hover \{/)
})

test('idle 状态不创建视觉徽标，保留中性状态圆点和其余异常运行态徽标', () => {
  assert.match(runtimeList, /if \(status === 'streaming'\) return \{ label: labels.streaming/)
  assert.match(runtimeList, /if \(status === 'failed'\) return \{ label: labels.failed/)
  assert.match(runtimeList, /return null\s*\}/)
  assert.match(runtimeList, /\{badge && <StatusBadge className="task-live-status-badge"/)
  assert.match(runtimeList, /badge\?\.label \?\? t\('center.runtimeStatus.idle'\)/)
  assert.match(runtimeList, /'pi-live-idle-dot'/)
})

test('A → B → A 快速切换按轮次取消旧 RAF，卸载时释放动画和锚点', () => {
  assert.match(page, /const revision = \+\+historyScrollRevisionRef\.current/)
  assert.match(page, /historyScrollRevisionRef\.current !== revision/)
  assert.match(page, /window\.cancelAnimationFrame\(historyScrollFrameRef\.current\)/)
  assert.match(page, /useEffect\(\(\) => \(\) => \{[\s\S]*?historyScrollRevisionRef\.current \+= 1/)
  assert.doesNotMatch(page, /historyScrollTargetRef/)
})
