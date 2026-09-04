import {
  REVIEW_ROUND_ROOT_MARGIN_PX,
  REVIEW_ROUND_UNMOUNT_DELAY_MS,
  VIRTUAL_MOUNT_OBSERVER_STRATEGY,
} from '../../packages/web/src/components/VirtualRoundMount.js'

function argNumber(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length)
  const parsed = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`无效参数 --${name}=${raw}`)
  return parsed
}

function buildHeights(count: number): number[] {
  const pattern = [96, 132, 180, 220, 320, 480, 760]
  return Array.from({ length: count }, (_, index) => pattern[index % pattern.length]!)
}

function mountedCountAt(heights: number[], scrollTop: number, viewportHeight: number): number {
  const top = Math.max(0, scrollTop - REVIEW_ROUND_ROOT_MARGIN_PX)
  const bottom = scrollTop + viewportHeight + REVIEW_ROUND_ROOT_MARGIN_PX
  let cursor = 0
  let mounted = 0
  for (const height of heights) {
    const rowTop = cursor
    const rowBottom = cursor + height
    if (rowBottom >= top && rowTop <= bottom) mounted += 1
    cursor = rowBottom
  }
  return mounted
}

const rounds = Math.floor(argNumber('rounds', 1000))
const viewportHeight = Math.floor(argNumber('viewport-height', 800))
const budgetMounted = Math.floor(argNumber('budget-mounted', 40))
const heights = buildHeights(rounds)
const totalHeight = heights.reduce((sum, value) => sum + value, 0)
const step = Math.max(1, Math.floor(viewportHeight / 2))
let maxMounted = 0
let samples = 0

for (let scrollTop = 0; scrollTop <= Math.max(0, totalHeight - viewportHeight); scrollTop += step) {
  maxMounted = Math.max(maxMounted, mountedCountAt(heights, scrollTop, viewportHeight))
  samples += 1
}

const averageHeight = totalHeight / rounds
const observerInstances = VIRTUAL_MOUNT_OBSERVER_STRATEGY === 'shared-per-root' ? 1 : rounds
const result = {
  benchmark: 'review-virtualization-window',
  rounds,
  viewportHeight,
  rootMarginPx: REVIEW_ROUND_ROOT_MARGIN_PX,
  unmountDelayMs: REVIEW_ROUND_UNMOUNT_DELAY_MS,
  observerStrategy: VIRTUAL_MOUNT_OBSERVER_STRATEGY,
  observerInstances,
  averageRoundHeight: averageHeight,
  samples,
  maxMounted,
  budgetMounted,
}

console.log(`[AgentLens perf] Review 虚拟窗口 rounds=${rounds} viewport=${viewportHeight}px avgHeight=${averageHeight.toFixed(1)}px maxMounted=${maxMounted} budget=${budgetMounted} observers=${observerInstances} strategy=${VIRTUAL_MOUNT_OBSERVER_STRATEGY} rootMargin=${REVIEW_ROUND_ROOT_MARGIN_PX}px unmountDelay=${REVIEW_ROUND_UNMOUNT_DELAY_MS}ms`)
console.log(JSON.stringify(result))

if (rounds < 1000) throw new Error('alpha.3 Review 虚拟化门禁至少需要 1000 轮')
if (VIRTUAL_MOUNT_OBSERVER_STRATEGY !== 'shared-per-root') throw new Error(`Review IntersectionObserver 策略回退为 ${VIRTUAL_MOUNT_OBSERVER_STRATEGY}`)
if (observerInstances > 1) throw new Error(`1000 轮 Review IntersectionObserver 实例数 ${observerInstances} 超过预算 1`)
if (REVIEW_ROUND_ROOT_MARGIN_PX > 1800) throw new Error(`Review rootMargin ${REVIEW_ROUND_ROOT_MARGIN_PX}px 超过 alpha.3 预算 1800px`)
if (REVIEW_ROUND_UNMOUNT_DELAY_MS > 500) throw new Error(`Review 远屏卸载延迟 ${REVIEW_ROUND_UNMOUNT_DELAY_MS}ms 超过 alpha.3 预算 500ms`)
if (maxMounted > budgetMounted) throw new Error(`1000 轮 Review 最大重子树挂载数 ${maxMounted} 超过预算 ${budgetMounted}`)
