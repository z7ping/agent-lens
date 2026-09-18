import { performance } from 'node:perf_hooks'
import type { LiveRuntimeEventDto } from '@agent-lens/protocol'
import { LiveEventScheduler } from '../../packages/web/src/client/live.js'

function argNumber(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length)
  const parsed = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`无效参数 --${name}=${raw}`)
  return parsed
}

function event(
  sequence: number,
  normalizedEvent: NonNullable<LiveRuntimeEventDto['normalizedEvent']>,
): LiveRuntimeEventDto {
  return {
    runtimeSessionId: 'benchmark-runtime',
    sequence,
    receivedAt: new Date(1_700_000_000_000 + sequence).toISOString(),
    event: {},
    normalizedEvent,
  }
}

const deltaEvents = Math.floor(argNumber('delta-events', 50_000))
const budgetPushMs = argNumber('budget-push-ms', 500)
const budgetDeliveredRatio = argNumber('budget-delivered-ratio', 0.002)

let delivered = 0
let batches = 0
const scheduler = new LiveEventScheduler(events => {
  delivered += events.length
  batches += 1
})

let sequence = 1
const startedAt = performance.now()
scheduler.push(event(sequence++, { type: 'message.start', role: 'assistant', messageId: 'assistant-1' }))
const textEvents = Math.max(1, Math.floor(deltaEvents * 0.8))
for (let index = 0; index < deltaEvents; index += 1) {
  const reasoning = index >= textEvents
  scheduler.push(event(sequence++, {
    type: reasoning ? 'reasoning.delta' : 'text.delta',
    messageId: 'assistant-1',
    contentIndex: reasoning ? 1 : 0,
    delta: 'x',
  }))
}
scheduler.flush()
const pushMs = performance.now() - startedAt
const visible = scheduler.snapshot()

const deliveredBeforeDispose = delivered
scheduler.push(event(sequence++, {
  type: 'text.delta',
  messageId: 'assistant-2',
  contentIndex: 0,
  delta: 'stale',
}))
scheduler.dispose()
scheduler.flush()

const deliveredRatio = visible.deliveredEvents / visible.ingressEvents
const result = {
  benchmark: 'generic-live-event-scheduler',
  deltaEvents,
  ingressEvents: visible.ingressEvents,
  deliveredEvents: visible.deliveredEvents,
  coalescedEvents: visible.coalescedEvents,
  maxQueueDepth: visible.maxQueueDepth,
  batches,
  pushMs,
  deliveredRatio,
  staleDeliveriesOnDispose: delivered - deliveredBeforeDispose,
  budgetPushMs,
  budgetDeliveredRatio,
}

console.log(`[AgentLens perf] Generic Live Scheduler ingress=${result.ingressEvents} delivered=${result.deliveredEvents} coalesced=${result.coalescedEvents} push=${pushMs.toFixed(2)}ms ratio=${(deliveredRatio * 100).toFixed(3)}% disposeStale=${result.staleDeliveriesOnDispose}`)
console.log(JSON.stringify(result))

if (result.staleDeliveriesOnDispose !== 0) throw new Error('Live 调度器销毁时仍交付了过期事件')
if (pushMs > budgetPushMs) throw new Error(`Live 高频事件入队 ${pushMs.toFixed(2)}ms 超过预算 ${budgetPushMs}ms`)
if (deliveredRatio > budgetDeliveredRatio) throw new Error(`Live 事件交付比 ${(deliveredRatio * 100).toFixed(3)}% 超过预算 ${(budgetDeliveredRatio * 100).toFixed(3)}%`)
if (visible.coalescedEvents < deltaEvents - 3) throw new Error('Live 连续 text/reasoning delta 未形成足够合并')
