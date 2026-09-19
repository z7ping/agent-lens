import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const taskSurface = readFileSync(new URL('./TaskSurface.tsx', import.meta.url), 'utf8')
const liveTask = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')
const review = readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8')

test('轮次导轨使用统一阅读锚点且锚定 Session Document', () => {
  assert.match(taskSurface, /TASK_ROUND_ANCHOR_RATIO\s*=\s*\.3/)
  assert.match(taskSurface, /roundAnchorY\(viewportRect\)/)
  assert.match(taskSurface, /delta = item\.element\.getBoundingClientRect\(\)\.top - roundAnchorY\(viewportRect\)/)
  assert.doesNotMatch(taskSurface, /scrollIntoView\(\{[^}]*block:\s*['"]center['"]/)
  assert.match(taskSurface, /sessionRailLeft/)
  assert.match(taskSurface, /\.task-session-document/)
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

test('轮次导轨逻辑覆盖全量轮次，80 只属于视觉 DOM 上限', () => {
  assert.match(liveTask, /historyIndexAnchorCursorRef\.current[\s\S]{0,260}\? \{ cursor: historyIndexAnchorCursorRef\.current \}[\s\S]{0,120}: \{ limit: 0 \}/)
  assert.match(liveTask, /fromOrdinal: targetOrdinal, limit: 1/)
  assert.match(liveTask, /around: cursor, limit: LIVE_TASK_SNAPSHOT_PAGE_LIMIT/)
  assert.match(liveTask, /turnRailTotal=\{turnRailTotal\}/)
  assert.match(taskSurface, /turnRailTotal\?: number/)
  assert.match(taskSurface, /ratio \* Math\.max\(0, turnRailTotal! - 1\)/)
  assert.match(taskSurface, /style=\{\{ top:/)
  assert.match(taskSurface, /pendingTurnRailTargetRef/)
  assert.doesNotMatch(liveTask, /historyIndex\(current\.liveId, current\.runtimeSessionId, 80\)/)
})


test('80 只限制导轨 DOM，不限制全会话轮次数据语义', () => {
  assert.match(taskSurface, /TASK_TURN_RAIL_MAX_TICKS\s*=\s*80/)
  assert.match(taskSurface, /sampledRoundOrdinals\(total!/)
  assert.match(taskSurface, /turnRailTotal/)
  assert.match(liveTask, /fromOrdinal: targetOrdinal, limit: 1/)
  assert.doesNotMatch(liveTask, /historyIndex\([^\n]*80/)
})


test('导轨任意指针位置映射真实 ordinal，而不是只能点击采样刻度', () => {
  assert.match(taskSurface, /const jumpToRailPosition = \(clientY: number/)
  assert.match(taskSurface, /ratio \* Math\.max\(0, turnRailTotal! - 1\)/)
  assert.match(taskSurface, /event\.detail > 0/)
  assert.match(taskSurface, /jumpToRailPosition\(event\.clientY, event\.currentTarget\.parentElement\)/)
})
