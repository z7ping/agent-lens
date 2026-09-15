import { performance } from 'node:perf_hooks'
import { ComposerDraftPresenceGate } from '../../packages/web/src/components/pi-markdown-composer-state.js'
import { sameStablePiLiveHistoryRoundProps } from '../../packages/web/src/features/pi-live-render-boundary.js'

function argNumber(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length)
  const parsed = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`无效参数 --${name}=${raw}`)
  return parsed
}

const edits = Math.floor(argNumber('edits', 100_000))
const historyRounds = Math.floor(argNumber('history-rounds', 250))
const streamingUpdates = Math.floor(argNumber('streaming-updates', 20_000))
const budgetMs = argNumber('budget-ms', 500)
const budgetParentUpdates = Math.floor(argNumber('budget-parent-updates', 2))
const budgetHistoryInvalidations = Math.floor(argNumber('budget-history-invalidations', 1))

const gate = new ComposerDraftPresenceGate()
const projections = Array.from({ length: historyRounds }, (_, index) => ({ id: `round-${index}` }))
const stableRoundProps = projections.map(projection => ({
  projection,
  showAllEvents: true,
  eager: false,
  estimate: 220,
}))
let parentUpdates = 0
let historyRenderInvalidations = 0
const startedAt = performance.now()

for (let index = 0; index < edits; index += 1) {
  // Represents local Lexical edits while the draft remains non-empty.
  if (gate.accept(true)) parentUpdates += 1
}
if (gate.accept(false)) parentUpdates += 1

// Simulate the parent work that may occur at draft boundaries and while the
// current round keeps streaming. Settled history props remain referentially
// stable, so React.memo must keep those rounds out of the render path.
for (let update = 0; update < parentUpdates + streamingUpdates; update += 1) {
  for (const props of stableRoundProps) {
    if (!sameStablePiLiveHistoryRoundProps(props, props)) historyRenderInvalidations += 1
  }
}

const durationMs = performance.now() - startedAt
const result = {
  benchmark: 'pi-live-composer-draft-boundary',
  edits,
  historyRounds,
  streamingUpdates,
  parentUpdates,
  historyRenderInvalidations,
  durationMs,
  updatesPerEdit: parentUpdates / edits,
  budgetMs,
  budgetParentUpdates,
  budgetHistoryInvalidations,
}

console.log(`[AgentLens perf] Pi Live Composer edits=${edits} historyRounds=${historyRounds} streamingUpdates=${streamingUpdates} parentUpdates=${parentUpdates} historyInvalidations=${historyRenderInvalidations} duration=${durationMs.toFixed(2)}ms updates/edit=${result.updatesPerEdit.toFixed(6)}`)
console.log(JSON.stringify(result))

if (parentUpdates > budgetParentUpdates) {
  throw new Error(`Composer ${edits} 次本地编辑触发 ${parentUpdates} 次父级更新，超过预算 ${budgetParentUpdates}`)
}
if (historyRenderInvalidations > budgetHistoryInvalidations) {
  throw new Error(`Composer/Streaming 导致稳定历史轮次失效 ${historyRenderInvalidations} 次，超过预算 ${budgetHistoryInvalidations}`)
}
if (durationMs > budgetMs) {
  throw new Error(`Composer 草稿与历史隔离基准 ${durationMs.toFixed(2)}ms 超过预算 ${budgetMs}ms`)
}
