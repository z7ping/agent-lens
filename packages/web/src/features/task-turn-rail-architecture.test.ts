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

test('边界导航位于正文右侧留白并避让 Live 排队消息', () => {
  assert.match(taskSurface, /documentRight \+ 24/)
  assert.match(taskSurface, /live-task-queue, \.live-task-startup-queue/)
  assert.match(taskSurface, /window\.innerHeight - Math\.min\(\.\.\.collisions/)
  assert.match(taskSurface, /queueObserver\?\.observe\(floating/)
  assert.match(railCss, /\.task-boundary-nav > \.ui-icon-button \{[\s\S]*?width: 34px;[\s\S]*?box-shadow: none;/)
})

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
  const layoutEffect = taskSurface.match(/useEffect\(\(\) => \{\s*const root = rootRef\.current\s*if \(!root\) return\s*scheduleRailViewport\(\)[\s\S]*?\}, \[scheduleRailViewport(?:, updateRailViewport)?\]\)/)?.[0]
  assert.ok(layoutEffect, '共享布局监听必须独立于有条件的轮次扫描')
  assert.match(layoutEffect, /new ResizeObserver\((?:scheduleRailViewport|updateRailViewport)\)/)
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


test('Live 首屏最新优先、索引独立加载，上下按钮可打断自动分页', () => {
  const boot = readFileSync(new URL('./use-live-task-runtime.ts', import.meta.url), 'utf8')
  const history = readFileSync(new URL('./use-live-task-history.ts', import.meta.url), 'utf8')
  const page = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')
  assert.match(boot, /edge: 'latest', limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT/)
  assert.match(boot, /void metadataRequest\.then\(async matched =>/)
  assert.match(boot, /setHistoryIndex\(index\)/)
  assert.match(boot, /setHistoryIndex\(latest\)/)
  assert.doesNotMatch(boot, /historyIndexValue/)
  assert.match(history, /const epoch = beginHistoryNavigation\(\)/)
  assert.match(history, /if \(epoch !== navigationEpochRef\.current\) return/)
  assert.match(page, /beginHistoryNavigation\(\)/)
  assert.match(page, /isHistoryNavigationCurrent\(navigationEpoch\)/)
  assert.doesNotMatch(page, /startDisabled: historyLoading/)
  assert.doesNotMatch(page, /endDisabled: historyLoading/)
  assert.match(taskSurface, /pendingTurnRailTargetRef\.current = null/)
})

test('Live 正文内存窗口最多保留五个 Snapshot 页块', () => {
  assert.match(liveHistoryWindow, /LIVE_TASK_HISTORY_WINDOW_MAX_PAGES\s*=\s*5/)
  assert.match(liveHistoryWindow, /export function compactHistoryBlocks/)
  assert.match(liveHistoryWindow, /removedIds/)
  assert.match(liveTask, /historyBlocksRef/)
})

test('轮次导轨保留全量语义与有界按 ordinal 定位，但视觉恢复旧版流式布局', () => {
  assert.match(liveTask, /current\.runtimeSessionId, \{ limit: 0 \}/)
  assert.match(liveTask, /fromOrdinal: Math\.max\(1, index\.total - 31\), limit: 32/)
  assert.match(liveTask, /loaded: false/)
  assert.match(liveTask, /historyIndex\?\.items/)
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
  assert.match(timeline, /rootSelector="\.task-session-reader"/)
  assert.match(taskSurface, /\.virtual-round-shell\[data-interaction-id\]/)
  assert.match(liveTask, /turnRailItems=\{turnRailItems\}/)
})

test('Live 用单一处理详情容器管理过程，结论单独展示，思考不算工具', () => {
  const timeline = readFileSync(new URL('./LiveTaskTimeline.tsx', import.meta.url), 'utf8')
  assert.match(timeline, /projectTaskReading\(projection\.items\.map/)
  assert.match(timeline, /const processItems = reading\.process\.map/)
  assert.match(timeline, /item\.phase === 'commentary'/)
  assert.match(timeline, /<TaskSessionProcess/)
  assert.match(timeline, /thinkingCount=\{thinkingCount\}/)
  assert.match(timeline, /toolCount=\{toolCount\}/)
  const shared = readFileSync(new URL('./TaskSessionContent.tsx', import.meta.url), 'utf8')
  assert.match(shared, /defaultExpanded=\{mode === 'live' && props\.state === 'running'\}/)
  assert.doesNotMatch(shared, /autoCollapseOnSettle/)
  assert.doesNotMatch(timeline, /<LiveToolGroup/)
  assert.match(timeline, /<TaskSessionTool/)
  assert.match(timeline, /showContentActions=\{item\.kind === 'message'/)
  assert.match(timeline, /process=\{process\}/)
  assert.match(timeline, /answer=\{<>/)
  assert.doesNotMatch(timeline, /flushProcess\(\); content\.push\(renderItem\(item\)\)/)
})
\ntest('共享轮次导航支持按编号直达未加载轮次，不扩张 80 个 DOM 刻度', () => {
  assert.match(taskSurface, /roundJumpEnabled = roundJumpTotal > 0 && typeof onTurnRailSelect === 'function'/)
  assert.match(taskSurface, /Number\.isSafeInteger\(requestedOrdinal\)/)
  assert.match(taskSurface, /requestedOrdinal >= 1 && requestedOrdinal <= roundJumpTotal/)
  assert.match(taskSurface, /jumpToRound\(railItems\.find\(item => item\.ordinal === requestedOrdinal\) \?\? virtualTurnRailItem\(requestedOrdinal\)\)/)
  assert.match(taskSurface, /<Popover[\s\S]*anchorRef=\{roundJumpAnchor === 'desktop' \? desktopRoundJumpRef : compactRoundJumpRef\}/)
  assert.match(taskSurface, /<Input[\s\S]*type="number"[\s\S]*max=\{roundJumpTotal\}/)
  assert.match(taskSurface, /TASK_TURN_RAIL_MAX_TICKS = 80/)
})

test('Native Review 索引尚未完成时只能跳已验证前缀，不伪造全量总数', () => {
  assert.match(taskSurface, /turnRailKnownCount\?: number/)
  assert.match(taskSurface, /Number\.isSafeInteger\(turnRailKnownCount\)/)
  assert.match(taskSurface, /const roundJumpTotal = Number\.isSafeInteger\(turnRailTotal\)/)
  assert.match(taskSurface, /Math\.min\(activeOrdinal \?\? roundJumpTotal, roundJumpTotal\)/)
  assert.match(taskSurface, /turnRailTotal === undefined && turnRailKnownCount !== undefined/)
  assert.match(review, /turnRailKnownCount=\{detail\?\.statisticsCompleteness==='window'/)
  assert.match(review, /nativeTurnIndex\.knownTurns:undefined/)
  assert.match(review, /nativeTurnIndex\.coverage==='complete'/)
})
