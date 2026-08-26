import { performance } from 'node:perf_hooks'
import { AgentLensClientModel } from '../../packages/web/src/client/model.js'
import type { AgentLensApi } from '../../packages/web/src/client/api.js'
import type { LiveUpdateEventDto } from '@agent-lens/protocol'

function argNumber(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length)
  const parsed = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`无效参数 --${name}=${raw}`)
  return parsed
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index] ?? 0
}

async function measureOne(index: number): Promise<number> {
  const logicalSessionId = `live-session-${index}`
  let afterEvent = false
  let emitEvent: ((event: LiveUpdateEventDto) => void) | null = null

  const api = {
    subscribe(onEvent: (event: LiveUpdateEventDto) => void, onConnection: (connected: boolean) => void) {
      emitEvent = onEvent
      queueMicrotask(() => onConnection(true))
      return () => { emitEvent = null }
    },
    async health() { return null },
    async facets() { return { agents: [], projects: [] } },
    async agents() { return { items: [] } },
    async review() {
      return afterEvent
        ? { items: [{ id: logicalSessionId }], meta: { hasMore: false } }
        : { items: [], meta: { hasMore: false } }
    },
    async usage() { return { tools: [], assets: [], sessions: [] } },
    async reviewDetail() { return { id: logicalSessionId, interactions: [], page: { hasMore: false, direction: 'forward', filter: 'all' } } },
    async relationships() { return { items: [] } },
  } as unknown as AgentLensApi

  const model = new AgentLensClientModel(api)
  await model.start()
  if (!emitEvent) throw new Error('Web ClientModel 没有建立实时订阅')

  let startedAt = 0
  let unsubscribe = () => undefined
  const visible = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('新事件未在 2 秒内进入 Web 可渲染状态')), 2000)
    unsubscribe = model.subscribe(() => {
      const snapshot = model.getSnapshot()
      if (!snapshot.review.response?.items.some(item => item.id === logicalSessionId)) return
      clearTimeout(timeout)
      resolve(performance.now() - startedAt)
    })
  })

  afterEvent = true
  startedAt = performance.now()
  emitEvent({
    type: 'observation.committed',
    occurredAt: new Date().toISOString(),
    logicalSessionId,
    affected: ['review'],
  } as LiveUpdateEventDto)

  try {
    return await visible
  } finally {
    unsubscribe()
    model.stop()
  }
}

const samples = Math.floor(argNumber('samples', 10))
const budgetP95Ms = argNumber('budget-p95-ms', 500)
const values: number[] = []
for (let index = 0; index < samples; index += 1) values.push(await measureOne(index))

const p50 = percentile(values, 0.5)
const p95 = percentile(values, 0.95)
const max = Math.max(...values)
console.log(`[AgentLens perf] Web 新事件可渲染延迟 samples=${samples} P50=${p50.toFixed(2)}ms P95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms budget=${budgetP95Ms}ms`)
console.log(JSON.stringify({ benchmark: 'web-live-visibility', samples, p50Ms: p50, p95Ms: p95, maxMs: max, budgetP95Ms }))

if (p95 > budgetP95Ms) {
  throw new Error(`Web 新事件可渲染延迟 P95 ${p95.toFixed(2)}ms 超过预算 ${budgetP95Ms}ms`)
}
