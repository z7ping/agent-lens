import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const reviewPage = readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8')
const piLivePage = readFileSync(new URL('./PiLivePage.tsx', import.meta.url), 'utf8')
const taskThinking = readFileSync(new URL('./TaskThinking.tsx', import.meta.url), 'utf8')
const mainEntry = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')

test('Task Review defaults to full observable events without a DOM adapter', () => {
  assert.match(reviewPage, /const \[showAllEvents, setShowAllEvents\] = useState\(true\)/)
  assert.match(reviewPage, /setShowAllEvents\(true\)/)
  assert.doesNotMatch(reviewPage, /const \[showAllEvents, setShowAllEvents\] = useState\(false\)/)
  assert.doesNotMatch(reviewPage, /setShowAllEvents\(false\)/)
})

test('Task Review 的独立 Thinking 仍可折叠，聚合思考过程默认展开以露出工具明细', () => {
  assert.match(reviewPage, /<TaskThinking[\s\S]*?defaultExpanded=\{false\}/)
  assert.match(taskThinking, /return defaultExpanded \|\| model\.label === '思考过程'/)
  assert.match(taskThinking, /useState\(defaultExpanded\)/)
})

test('Task Review 将 commentary、reasoning 与工具统一放入思考过程', () => {
  assert.match(reviewPage, /label: '思考过程'/)
  assert.match(reviewPage, /entry\.type === 'process'/)
})

test('Task Review 的附加原生事件折叠时不挂载事件行', () => {
  assert.match(reviewPage, /function RawEventGroup[\s\S]*?const \[expanded, setExpanded\] = useState\(false\)[\s\S]*?className="raw-event-group"/)
  assert.match(reviewPage, /\{expanded && <div>\{items\.map\(item => <EventRow/)
})

test('Task Review 滚到顶部不会自动加载更早轮次并抢走滚动位置', () => {
  assert.match(reviewPage, /detail\.page\.direction !== 'forward'/)
  assert.doesNotMatch(reviewPage, /detail\.page\.direction === 'backward'\) void loadOlder/)
  assert.match(reviewPage, /加载更早轮次/)
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

test('Task Review 已挂载轮次不会退回估算高度占位', () => {
  assert.match(reviewPage, /<VirtualRoundMount[\s\S]*?retainMounted/)
})

test('Pi Live defaults and resets to full observable events natively', () => {
  assert.match(piLivePage, /const \[showAllEvents, setShowAllEvents\] = useState\(true\)/)
  assert.match(piLivePage, /setShowAllEvents\(true\)/)
  assert.doesNotMatch(piLivePage, /setShowAllEvents\(false\)/)
})

test('legacy Task Surface MutationObserver compatibility layer is removed', () => {
  assert.equal(existsSync(new URL('../client/task-surface-defaults.ts', import.meta.url)), false)
  assert.doesNotMatch(mainEntry, /installTaskSurfaceDefaults|task-surface-defaults/)
})
