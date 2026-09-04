import { readFile } from 'node:fs/promises'

function numberArg(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const value = process.argv.find(item => item.startsWith(prefix))?.slice(prefix.length)
  const parsed = value ? Number(value) : fallback
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid --${name}: ${value ?? ''}`)
  return parsed
}

const facts = Math.floor(numberArg('facts', 4000))
const viewportHeight = numberArg('viewport-height', 800)
const minimumFactHeight = numberArg('minimum-fact-height', 38)
const budgetMountedFacts = Math.floor(numberArg('budget-mounted-facts', 160))
const budgetObserverInstances = Math.floor(numberArg('budget-observer-instances', 1))

const [page, mount, projection] = await Promise.all([
  readFile(new URL('../../packages/web/src/features/PiLivePage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../packages/web/src/components/VirtualRoundMount.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../packages/web/src/features/pi-live-task-projection.ts', import.meta.url), 'utf8'),
])

const chunkSize = Number(projection.match(/PI_LIVE_HISTORY_ROUND_FACT_LIMIT\s*=\s*(\d+)/)?.[1])
const eagerChunks = Number(page.match(/PI_LIVE_EAGER_CHUNKS\s*=\s*(\d+)/)?.[1])
const rootMargin = Number(mount.match(/REVIEW_ROUND_ROOT_MARGIN_PX\s*=\s*(\d+)/)?.[1])

if (!Number.isFinite(chunkSize) || chunkSize <= 0) throw new Error('Cannot resolve Pi Live history chunk size')
if (!Number.isFinite(eagerChunks) || eagerChunks < 0) throw new Error('Cannot resolve Pi Live eager chunk count')
if (!Number.isFinite(rootMargin) || rootMargin < 0) throw new Error('Cannot resolve virtual mount root margin')
if (!/rootSelector="\.pi-live-reader"/.test(page)) throw new Error('Pi Live history is not mounted against .pi-live-reader')
if (!/visibleHistoryRounds\.map/.test(page) || !/VirtualRoundMount/.test(page) || !/PiLiveHistoryTaskRound/.test(page)) throw new Error('Pi Live semantic round virtualization is missing')
if (!/sharedVirtualObservers\s*=\s*new WeakMap/.test(mount)) throw new Error('VirtualRoundMount must share IntersectionObserver per scroll root')
if (!/observer\.unobserve\(element\)/.test(mount)) throw new Error('Shared virtual observer must unobserve disposed targets')
if (!/listeners\.size === 0[\s\S]*observer\.disconnect/.test(mount)) throw new Error('Shared virtual observer must disconnect when the last target leaves')

const chunkHeight = minimumFactHeight * chunkSize
const observationWindowHeight = viewportHeight + rootMargin * 2
const intersectingChunks = Math.ceil(observationWindowHeight / chunkHeight) + 2
const mountedChunks = Math.min(Math.ceil(facts / chunkSize), intersectingChunks + eagerChunks)
const mountedFacts = Math.min(facts, mountedChunks * chunkSize)
const observedTargets = Math.ceil(facts / chunkSize)
const observerInstances = observedTargets > 0 ? 1 : 0

const report = {
  facts,
  viewportHeight,
  rootMargin,
  chunkSize,
  eagerChunks,
  minimumFactHeight,
  observedTargets,
  observerInstances,
  budgetObserverInstances,
  maxMountedHeavyFacts: mountedFacts,
  budgetMountedFacts,
}

console.log(JSON.stringify(report, null, 2))

if (mountedFacts > budgetMountedFacts) {
  throw new Error(`Pi Live mounted heavy fact budget exceeded: ${mountedFacts} > ${budgetMountedFacts}`)
}
if (observerInstances > budgetObserverInstances) {
  throw new Error(`Pi Live IntersectionObserver instance budget exceeded: ${observerInstances} > ${budgetObserverInstances}`)
}
