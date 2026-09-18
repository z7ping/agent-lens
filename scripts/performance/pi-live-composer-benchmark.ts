import { performance } from 'node:perf_hooks'
import { ComposerDraftPresenceGate } from '../../packages/web/src/components/live-markdown-composer-state.js'
import {
  LiveTaskRoundProjector,
  type LiveTaskProjectionItem,
} from '../../packages/web/src/features/live-task-projection.js'

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
const budgetMs = argNumber('budget-ms', 800)
const budgetParentUpdates = Math.floor(argNumber('budget-parent-updates', 2))
const budgetHistoryInvalidations = Math.floor(argNumber('budget-history-invalidations', 0))

const gate = new ComposerDraftPresenceGate()
const stableItems: LiveTaskProjectionItem[] = []
for (let index = 0; index < historyRounds; index += 1) {
  stableItems.push(
    { id: `u-${index}`, kind: 'message', role: 'user', text: `task ${index}`, streaming: false },
    { id: `a-${index}`, kind: 'message', role: 'assistant', text: 'done', streaming: false },
  )
}

const projector = new LiveTaskRoundProjector()
const stableRounds = projector.projectSegmented(stableItems, []).stable

let parentUpdates = 0
let historyRenderInvalidations = 0
const startedAt = performance.now()

for (let index = 0; index < edits; index += 1) {
  if (gate.accept(true)) parentUpdates += 1
}
if (gate.accept(false)) parentUpdates += 1

for (let update = 0; update < streamingUpdates; update += 1) {
  const activeItems: LiveTaskProjectionItem[] = [
    { id: 'u-current', kind: 'message', role: 'user', text: 'current task', streaming: false },
    { id: 'a-current', kind: 'message', role: 'assistant', text: `stream-${update}`, streaming: true },
  ]
  const segments = projector.projectSegmented(stableItems, activeItems)
  if (segments.stable !== stableRounds) historyRenderInvalidations += 1
  if (!segments.active.length) throw new Error('Streaming update lost the active round')
}

const durationMs = performance.now() - startedAt
const result = {
  benchmark: 'generic-live-composer-render-boundary',
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

console.log(`[AgentLens perf] Live Composer edits=${edits} historyRounds=${historyRounds} streamingUpdates=${streamingUpdates} parentUpdates=${parentUpdates} historyInvalidations=${historyRenderInvalidations} duration=${durationMs.toFixed(2)}ms updates/edit=${result.updatesPerEdit.toFixed(6)}`)
console.log(JSON.stringify(result))

if (parentUpdates > budgetParentUpdates) {
  throw new Error(`Composer ${edits} 次本地编辑触发 ${parentUpdates} 次父级更新，超过预算 ${budgetParentUpdates}`)
}
if (historyRenderInvalidations > budgetHistoryInvalidations) {
  throw new Error(`Composer/Streaming 导致稳定历史轮次失效 ${historyRenderInvalidations} 次，超过预算 ${budgetHistoryInvalidations}`)
}
if (durationMs > budgetMs) {
  throw new Error(`Composer 与通用 Live 历史隔离基准 ${durationMs.toFixed(2)}ms 超过预算 ${budgetMs}ms`)
}
