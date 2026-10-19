import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const taskSurface = readFileSync(new URL('./TaskSurface.tsx', import.meta.url), 'utf8')
const liveTask = [
  readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./use-live-task-runtime.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./use-live-task-history.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./use-live-task-actions.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./live-task-state.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./live-task-queue.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./live-task-input.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./LiveTaskTimeline.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./live-task-history-window.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('./task-live-runtime.ts', import.meta.url), 'utf8')
].join('\n')
const liveHistoryWindow = readFileSync(new URL('./live-task-history-window.ts', import.meta.url), 'utf8')
const review = [
  'review-session-format.ts', 'ReviewEvidenceInspector.tsx', 'ReviewRoundPresentation.tsx',
  'review-reader-position.ts', 'use-review-session.ts', 'ReviewPage.tsx',
].map(file => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')).join('\n')
const railCss = readFileSync(new URL('../task-turn-rail.css', import.meta.url), 'utf8')

test('轮次导轨保持旧版共享阅读锚点与 Rail Frame 位置', () => {
  assert.match(taskSurface, /TASK_ROUND_ANCHOR_RATIO\s*=\s*\.3/)
  assert.match(taskSurface, /roundAnchorY\(viewportRect\)/)
  assert.match(taskSurface, /delta = item\.element\.getBoundingClientRect\(\)\.top - roundAnchorY\(viewportRect\)/)
  assert.doesNotMatch(taskSurface, /scrollIntoView\(\{[^}]*block:\s*['"]center['"]/)
  assert.match(taskSurface, /left:\s*railFrame\.left \+ 10/)
  assert.doesNotMatch(taskSurface, /sessionRailLeft/)
})

test('Review 与 Live 导轨由轮次数据驱动，并在数据到达后释放 fallback MutationObserver', () => {
  assert.match(taskSurface, /turnRailItems\?: readonly TaskTurnRailData\[]/)
  assert.match(taskSurface, /const hasProvidedTurnRailItems = providedTurnRailItems !== undefined/)
  assert.match(taskSurface, /if \(hasProvidedTurnRailItems\) return/)
  assert.match(taskSurface, /\[hasProvidedTurnRailItems, scanRounds\]/)
  assert.match(liveTask, /turnRailItems=\{turnRailItems\}/)
  assert.match(review, /turnRailItems=\{detail \? turnRailItems : undefined\}/)
})

test('侧栏展开/收起时共享导轨几何监听不依赖 fallback DOM 轮次扫描', () => {
  const layoutEffect = taskSurface.match(/useEffect\(\(\) => \{\s*const root = rootRef\.current\s*if \(!root\) return\s*scheduleRailViewport\(\)[\s\S]*?\}, \[scheduleRailViewport\]\)/)?.[0]
  assert.ok(layoutEffect, '共享布局监听必须独立于有条件的轮次扫描')
  assert.match(layoutEffect, /new ResizeObserver\(scheduleRailViewport\)/)
  assert.match(layoutEffect, /resizeObserver\?\.observe\(root\)/)
  assert.match(layoutEffect, /root\.addEventListener\('scroll', scheduleRailViewport, true\)/)
  assert.match(layoutEffect, /window\.addEventListener\('resize', scheduleRailViewport\)/)
  assert.match(layoutEffect, /resizeObserver\?\.disconnect\(\)/)
  assert.doesNotMatch(layoutEffect, /hasProvidedTurnRailItems/)
  assert.match(taskSurface, /const boundary = sessionBoundaryPosition\(root, railFrame, viewportRect\)/)
})

test('超长轮次导轨限制真实 DOM tick 数量', () => {
  assert.match(taskSurface, /TASK_TURN_RAIL_MAX_TICKS\s*=\s*80/)
  assert.match(taskSurface, /renderedRailItems = renderTurnRailItems/)
  assert.match(taskSurface, /sampledRoundOrdinals/)
  assert.match(taskSurface, /renderedRailItems\.map/)
})

test('Live 历史导航使用直接边界窗口与滚轮双向分页', () => {
  assert.match(liveTask, /edge, limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT/)
  assert.match(liveTask, /after: historyPage\.after, limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT/)
  assert.match(liveTask, /before: historyPage\.before, limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT/)
  assert.match(liveTask, /onWheel=\{event => markReaderUserIntent\(event\.deltaY < 0 \? 'older' : 'newer'\)\}/)
  assert.match(liveTask, /onStart: jumpEarliest/)
  assert.match(liveTask, /onEnd: jumpLatest/)
})


test('Live 正文内存窗口最多保留五个 Snapshot 页块', () => {
  assert.match(liveHistoryWindow, /LIVE_TASK_HISTORY_WINDOW_MAX_PAGES\s*=\s*5/)
  assert.match(liveHistoryWindow, /export function compactHistoryBlocks/)
  assert.match(liveHistoryWindow, /removedIds/)
  assert.match(liveTask, /historyBlocksRef/)
})

test('轮次导轨保留全量语义与有界按 ordinal 定位，但视觉恢复旧版流式布局', () => {
  assert.match(liveTask, /historyIndexAnchorCursorRef\.current[\s\S]{0,260}\? \{ cursor: historyIndexAnchorCursorRef\.current \}[\s\S]{0,120}: \{ limit: 0 \}/)
  assert.match(liveTask, /fromOrdinal: targetOrdinal, limit: 1/)
  assert.match(liveTask, /around: cursor, limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT/)
  assert.match(liveTask, /turnRailTotal=\{turnRailTotal\}/)
  assert.match(taskSurface, /turnRailTotal\?: number/)
  assert.match(taskSurface, /pendingTurnRailTargetRef/)
  assert.doesNotMatch(liveTask, /historyIndex\(current\.liveId, current\.runtimeSessionId, 80\)/)
  assert.doesNotMatch(taskSurface, /style=\{\{ top:/)
  assert.doesNotMatch(taskSurface, /jumpToRailPosition/)
})


test('80 只限制导轨 DOM，不限制全会话轮次数据语义', () => {
  assert.match(taskSurface, /TASK_TURN_RAIL_MAX_TICKS\s*=\s*80/)
  assert.match(taskSurface, /sampledRoundOrdinals\(total!/)
  assert.match(taskSurface, /turnRailTotal/)
  assert.match(liveTask, /fromOrdinal: targetOrdinal, limit: 1/)
  assert.doesNotMatch(liveTask, /historyIndex\([^\n]*80/)
})


test('轮次导轨视觉锁定 #283 前经典样式，不允许恢复绝对比例刻度', () => {
  assert.match(railCss, /\.task-turn-rail\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;/)
  assert.match(railCss, /\.task-turn-rail\s+\.turn-tick\s*\{[\s\S]*?position:\s*relative;[\s\S]*?flex:\s*0 1 9px;/)
  assert.doesNotMatch(railCss, /\.task-turn-rail\s+\.turn-tick\s*\{[^}]*position:\s*absolute;/s)
  assert.doesNotMatch(taskSurface, /jumpToRailPosition/)
  assert.doesNotMatch(taskSurface, /style=\{\{ top:/)
})

test('Live 正文不再使用轮次 details，但导轨仍使用独立语义锚点', () => {
  const timeline = readFileSync(new URL('./LiveTaskTimeline.tsx', import.meta.url), 'utf8')
  assert.match(timeline, /<TaskReadingRound/)
  assert.doesNotMatch(timeline, /<LiveTranscriptRound/)
  assert.doesNotMatch(timeline, /<TaskRound\b/)
  const shell = readFileSync(new URL('./TaskReadingRound.tsx', import.meta.url), 'utf8')
  assert.match(shell, /data-round-semantic-id=\{model\.semanticId \?\? model\.id\}/)
  const reviewPresentation = readFileSync(new URL('./ReviewRoundPresentation.tsx', import.meta.url), 'utf8')
  assert.match(reviewPresentation, /return <TaskReadingRound/)
  assert.doesNotMatch(reviewPresentation, /return <TaskRound/)
  assert.match(timeline, /rootSelector="\.pi-live-reader"/)
  assert.match(taskSurface, /\.virtual-round-shell\[data-interaction-id\]/)
  assert.match(liveTask, /turnRailItems=\{turnRailItems\}/)
})

test('Live 用单一处理详情容器管理过程，结论单独展示，思考不算工具', () => {
  const timeline = readFileSync(new URL('./LiveTaskTimeline.tsx', import.meta.url), 'utf8')
  assert.match(timeline, /projectTaskReading\(projection\.items\.map/)
  assert.match(timeline, /const processItems = reading\.process\.map/)
  assert.match(timeline, /item\.phase === 'commentary'/)
  assert.match(timeline, /<TaskProcessGroup/)
  assert.match(timeline, /thinkingCount=\{thinkingCount\}/)
  assert.match(timeline, /toolCount=\{toolCount\}/)
  assert.match(timeline, /defaultExpanded=\{processState === 'running'\}/)
  assert.match(timeline, /autoCollapseOnSettle/)
  assert.match(timeline, /<LiveToolGroup/)
  assert.match(timeline, /showContentActions=\{item\.kind === 'message'/)
  assert.match(timeline, /if \(!placedProcess && process\) content\.push\(process\)/)
  assert.doesNotMatch(timeline, /flushProcess\(\); content\.push\(renderItem\(item\)\)/)
})
