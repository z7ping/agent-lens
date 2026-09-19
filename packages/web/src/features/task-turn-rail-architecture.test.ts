import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const taskSurface = readFileSync(new URL('./TaskSurface.tsx', import.meta.url), 'utf8')
const liveTask = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')
const review = readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8')
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
  assert.match(taskSurface, /\[hasProvidedTurnRailItems, scanRounds, scheduleRailViewport\]/)
  assert.match(liveTask, /turnRailItems=\{turnRailItems\}/)
  assert.match(review, /turnRailItems=\{detail \? turnRailItems : undefined\}/)
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
  assert.match(liveTask, /LIVE_TASK_HISTORY_WINDOW_MAX_PAGES\s*=\s*5/)
  assert.match(liveTask, /compactHistoryBlocks/)
  assert.match(liveTask, /removedIds/)
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
