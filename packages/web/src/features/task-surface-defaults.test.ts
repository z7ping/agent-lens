import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const reviewPage = [ readFileSync(new URL('./review-session-format.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./ReviewEvidenceInspector.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./ReviewRoundPresentation.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./review-reader-position.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./use-review-session.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8') ].join('\n')
const liveTaskPage = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')
const taskThinking = readFileSync(new URL('./TaskThinking.tsx', import.meta.url), 'utf8')
const taskProcessGroup = readFileSync(new URL('./TaskProcessGroup.tsx', import.meta.url), 'utf8')
const taskDetailCss = readFileSync(new URL('../task-detail.css', import.meta.url), 'utf8')
const taskHeader = readFileSync(new URL('./TaskHeader.tsx', import.meta.url), 'utf8')
const taskSessionCss = readFileSync(new URL('../task-session-view.css', import.meta.url), 'utf8')
const mainEntry = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')

test('Task Review defaults to full observable events without a DOM adapter', () => {
  assert.match(reviewPage, /const \[showAllEvents, setShowAllEvents\] = useState\(true\)/)
  assert.match(reviewPage, /setShowAllEvents\(true\)/)
  assert.doesNotMatch(reviewPage, /const \[showAllEvents, setShowAllEvents\] = useState\(false\)/)
  assert.doesNotMatch(reviewPage, /setShowAllEvents\(false\)/)
})

test('Task Review 的 Thinking 和 Process 统一默认折叠，运行中摘要仍保持可观察', () => {
  assert.match(reviewPage, /<TaskThinking[\s\S]*?defaultExpanded=\{false\}/)
  assert.match(reviewPage, /<TaskProcessGroup[\s\S]*?defaultExpanded=\{false\}/)
  assert.match(taskProcessGroup, /defaultExpanded = false/)
  assert.match(taskProcessGroup, /state === 'running' && <span>\{t\('process\.running'\)\}<\/span>/)
  assert.match(taskThinking, /useState\(\(\) => expansionStore\?\.get\(model\.id\) \?\? defaultExpanded\)/)
})

test('Task Review 将 commentary、reasoning 与工具统一放入处理详情', () => {
  assert.match(reviewPage, /entry\.type === 'process'/)
  assert.match(reviewPage, /function ReviewProcessGroup/)
  assert.match(reviewPage, /return <TaskProcessGroup/)
  assert.match(reviewPage, /t\('local\.process\.output'\)/)
})

test('Task Review 的其他运行记录会解释用途，折叠时不挂载事件行', () => {
  assert.match(reviewPage, /function RawEventGroup[\s\S]*?return <TaskThinking[\s\S]*?kind="process"[\s\S]*?defaultExpanded=\{false\}/)
  assert.match(reviewPage, /local\.rawEvents\.title/)
  assert.doesNotMatch(reviewPage, /local\.rawEvents\.description/)
  assert.doesNotMatch(reviewPage, /className="raw-event-group"/)
})

test('Task Review 展示注入上下文正文，不再使用隐藏占位文案', () => {
  assert.match(reviewPage, /node\.kind === 'context\.injected'[\s\S]*?stringValue\(payload, 'text'\)/)
  assert.match(reviewPage, /className="injected-context-content"/)
  assert.doesNotMatch(reviewPage, /注入内容已隐藏/)
})

test('Task Review 更早轮次由用户滚动触发，且每页重新等待新的滚动意图', () => {
  assert.match(reviewPage, /detail\.page\.direction !== 'backward'/)
  assert.match(reviewPage, /readerUserRevisionRef\.current <= detailAutoLoadBaselineRef\.current/)
  assert.match(reviewPage, /detailAutoLoadBaselineRef\.current = userRevision/)
  assert.match(reviewPage, /void loadOlder\(\)\.finally/)
  assert.doesNotMatch(reviewPage, /t\('local\.roundNav\.loadOlder'\)/)
  assert.match(reviewPage, /loadFailedRetry/)
})

test('Task Review 大范围跳转后等待用户滚动再继续自动补载', () => {
  assert.match(reviewPage, /detailAutoLoadBaselineRef/)
  assert.match(reviewPage, /readerUserRevisionRef\.current <= detailAutoLoadBaselineRef\.current/)
  assert.match(reviewPage, /pendingReaderAnchorRef\.current = null/)
  assert.match(reviewPage, /overflow-anchor', 'none'/)
  assert.match(reviewPage, /scrollToBoundary\('top'\)/)
  assert.match(reviewPage, /scrollToBoundary\('bottom'\)/)
})

test('Task Review 用统一轮次锚点保护补载与大范围视图切换', () => {
  assert.match(reviewPage, /function restoreReviewReaderPosition/)
  assert.match(reviewPage, /pendingReaderAnchorRef/)
  assert.match(reviewPage, /readerUserRevisionRef/)
  assert.match(reviewPage, /onWheelCapture=\{noteReaderUserIntent\}/)
  assert.doesNotMatch(reviewPage, /beforeTop \+ \(current\.scrollHeight - beforeHeight\)/)
})

test('Task Review 允许离屏卸载重正文，并通过 expansionStore 保留展开意图', () => {
  assert.match(reviewPage, /<VirtualRoundMount/)
  assert.doesNotMatch(reviewPage, /<VirtualRoundMount[\s\S]{0,260}\bretainMounted\b/)
  assert.match(reviewPage, /expansionStore=\{roundExpansionRef\.current\}/)
})

test('通用 Live 的事件和轮次由统一 Task Surface 投影负责', () => {
  assert.match(liveTaskPage, /<StableLiveRounds/)
  assert.match(liveTaskPage, /<GenericLiveRound/)
  assert.doesNotMatch(liveTaskPage, /PiLivePage|piLiveApi/)
})

test('Review / Live 任务页头以任务标题为主，智能体与状态归入次行且不重复项目名', () => {
  const copy = taskHeader.slice(taskHeader.indexOf('<div className="task-header-copy">'), taskHeader.indexOf('{(metrics.length > 0 || hasHeaderActions)'))
  assert.ok(copy.indexOf('className="task-header-title"') < copy.indexOf('className="task-header-meta"'))
  assert.doesNotMatch(copy, /task-header-context/)
  assert.match(copy, /\{showStatus && <span className="task-header-status"/)
  assert.match(taskHeader, /\{resolvedContext && <div><span>\{t\('header\.context'\)\}/)

  assert.match(taskSessionCss, /\.task-session-view \.task-header-title \{ grid-column: 1; grid-row: 1; \}/)
  assert.match(taskSessionCss, /\.task-session-view \.task-header-secondary \{ grid-column: 1 \/ 3; grid-row: 2; \}/)
  assert.match(taskSessionCss, /\.task-session-view \.task-header-actions \{ grid-column: 3; grid-row: 1 \/ 3; \}/)
  assert.match(taskSessionCss, /\.task-session-view \.task-header-reading-controls \{[\s\S]*?flex: 1 1 auto;/)
  assert.doesNotMatch(taskSessionCss, /grid-template-rows: 26px 20px auto;/)
  assert.match(taskSessionCss, /@media \(max-width: 767\.98px\) \{[\s\S]*?\.task-session-view \.task-header-secondary \{ grid-column: 1; grid-row: 2; \}/)
  assert.match(taskDetailCss, /\.task-surface \.task-header-status::before \{/)

  assert.match(liveTaskPage, /label: t\('header\.context'\), value: workspace \|\| t\('header\.unlinkedProject'\)/)
  assert.match(reviewPage, /title=\{<span title=\{readableTaskHeaderTitle\(taskDetailModel\?\.title\)\}>\{compactTitle\(readableTaskHeaderTitle\(taskDetailModel\?\.title\)\)\}<\/span>\}/)
  assert.doesNotMatch(reviewPage, /compactTitle\(taskDetailModel\?\.title, 15\)/)
})

test('Review 筛选与智能体处于任务头部次行，页头只有一条底部分隔线', () => {
  const headerSecondary = taskHeader.slice(taskHeader.indexOf('<div className="task-header-secondary">'), taskHeader.indexOf('{(metrics.length > 0 || hasHeaderActions)'))
  assert.match(headerSecondary, /className="task-header-meta"/)
  assert.match(headerSecondary, /className="task-header-reading-controls"/)
  assert.ok(headerSecondary.indexOf('task-header-meta') < headerSecondary.indexOf('task-header-reading-controls'))
  assert.equal((taskHeader.match(/className="task-header-reading-controls"/g) ?? []).length, 1)
  assert.match(taskSessionCss, /grid-template-rows: 26px 28px;/)
  assert.doesNotMatch(taskSessionCss, /\.task-header:has\(\.task-header-reading-controls\)/)
  assert.match(taskDetailCss, /\.task-surface \.task-header-actions \.task-header-compact-info-trigger,/)
  assert.match(taskHeader, /aria-label=\{t\('header\.taskInfo'\)\}/)
  assert.match(taskHeader, /title=\{t\('header\.viewOptions'\)\}/)
  assert.match(reviewPage, /<Toolbar className="round-nav"/)
  const navCss = readFileSync(new URL('../review-long-session.css', import.meta.url), 'utf8')
  assert.match(navCss, /\.review-page \.round-nav \{[\s\S]*?min-height: 28px;/)
  // The nested shared Toolbar supplies a border by default; Review clears it
  // so only the surrounding TaskHeader's full-width divider remains.
  assert.match(navCss, /\.review-page \.round-nav \{[^}]*border-bottom: 0;/)
  assert.match(taskDetailCss, /\.task-surface \.task-header \{[^}]*border-bottom: 1px solid var\(--al-line\);/)
  assert.doesNotMatch(navCss, /min-height: 48px;/)
})

test('Live Header 使用统一的任务表头与安全边距', () => {
  assert.match(liveTaskPage, /<TaskHeader/)
  assert.match(taskSessionCss, /\.task-session-view \.task-header \{[\s\S]*?padding-inline: var\(--al-space-page-x\);/)
  assert.doesNotMatch(taskDetailCss, /\.task-surface-live \.task-header\s*\{/)
})

test('任务信息保留历史会话开始/结束时间，实时会话由统一运行时状态驱动', () => {
  assert.match(reviewPage, /label: t\('local\.header\.startTime'\)/)
  assert.match(reviewPage, /label: t\('local\.header\.endTime'\)/)
  assert.match(reviewPage, /label: t\('local\.header\.duration'\)/)
  assert.match(liveTaskPage, /runtimeStatus/)
  assert.match(liveTaskPage, /<TaskHeader/)
})

test('legacy Task Surface MutationObserver compatibility layer is removed', () => {
  assert.equal(existsSync(new URL('../client/task-surface-defaults.ts', import.meta.url)), false)
  assert.doesNotMatch(mainEntry, /installTaskSurfaceDefaults|task-surface-defaults/)
})
