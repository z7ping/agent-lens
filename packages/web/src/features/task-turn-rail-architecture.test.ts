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

test('Review 与 Live 导轨由轮次数据驱动，不依赖全树 MutationObserver 扫描', () => {
  assert.match(taskSurface, /turnRailItems\?: readonly TaskTurnRailData\[]/)
  assert.match(taskSurface, /if \(providedTurnRailItems\) return/)
  assert.match(liveTask, /turnRailItems=\{turnRailItems\}/)
  assert.match(review, /turnRailItems=\{detail \? turnRailItems : undefined\}/)
})

test('超长轮次导轨限制真实 DOM tick 数量', () => {
  assert.match(taskSurface, /TASK_TURN_RAIL_MAX_TICKS\s*=\s*80/)
  assert.match(taskSurface, /renderedRailItems = compactTurnRailItems/)
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
