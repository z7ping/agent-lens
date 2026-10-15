import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const reviewPage = readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8')
const liveTaskPage = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')
const taskThinking = readFileSync(new URL('./TaskThinking.tsx', import.meta.url), 'utf8')
const taskProcessGroup = readFileSync(new URL('./TaskProcessGroup.tsx', import.meta.url), 'utf8')
const taskDetailCss = readFileSync(new URL('../task-detail.css', import.meta.url), 'utf8')
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
  assert.match(reviewPage, /review:local\.process\.output/)
})

test('Task Review 的其他运行记录会解释用途，折叠时不挂载事件行', () => {
  assert.match(reviewPage, /function RawEventGroup[\s\S]*?const \[expanded, setExpanded\] = useState\(false\)[\s\S]*?className="raw-event-group"/)
  assert.match(reviewPage, /t\('local\.rawEvents\.title'\)/)
  assert.doesNotMatch(reviewPage, /local\.rawEvents\.description/)
  assert.match(reviewPage, /\{expanded && <div>\{items\.map\(item => <EventRow/)
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
