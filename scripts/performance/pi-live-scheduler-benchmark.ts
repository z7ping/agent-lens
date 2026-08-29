import { performance } from 'node:perf_hooks'
import type { PiLiveEventDto } from '@agent-lens/protocol'
import { PiLiveEventScheduler } from '../../packages/web/src/client/pi-live.js'

function argNumber(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length)
  const parsed = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`无效参数 --${name}=${raw}`)
  return parsed
}

function event(sequence: number, type: string, payload: Record<string, unknown>): PiLiveEventDto {
  return {
    runtimeSessionId: 'benchmark-runtime',
    sequence,
    receivedAt: new Date(1_700_000_000_000 + sequence).toISOString(),
    event: { type, ...payload },
  }
}

const globalRecord = globalThis as unknown as Record<string, unknown>
const originalDocument = globalRecord.document
const originalRaf = globalRecord.requestAnimationFrame
const originalCancelRaf = globalRecord.cancelAnimationFrame
let hidden = false

globalRecord.document = { get hidden() { return hidden } }
globalRecord.requestAnimationFrame = ((callback: (at: number) => void) => {
  const timer = setTimeout(() => callback(performance.now()), 0)
  return timer as unknown as number
}) as unknown
globalRecord.cancelAnimationFrame = ((id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>)) as unknown

try {
  const deltaEvents = Math.floor(argNumber('delta-events', 50_000))
  const toolCalls = Math.floor(argNumber('tool-calls', 100))
  const budgetPushMs = argNumber('budget-push-ms', 500)
  const budgetDeliveredRatio = argNumber('budget-delivered-ratio', 0.02)

  let delivered = 0
  let batches = 0
  const scheduler = new PiLiveEventScheduler(events => {
    delivered += events.length
    batches += 1
  })

  let sequence = 1
  const startedAt = performance.now()
  scheduler.push(event(sequence++, 'message_start', {}))
  for (let index = 0; index < deltaEvents; index += 1) {
    scheduler.push(event(sequence++, 'message_update', {
      assistantMessageEvent: {
        type: index % 5 === 0 ? 'thinking_delta' : 'text_delta',
        contentIndex: index % 5 === 0 ? 1 : 0,
        delta: 'x',
      },
    }))
  }
  for (let tool = 0; tool < toolCalls; tool += 1) {
    const id = `tool-${tool}`
    scheduler.push(event(sequence++, 'tool_execution_start', { toolCallId: id, toolName: 'benchmark' }))
    for (let update = 0; update < 20; update += 1) {
      scheduler.push(event(sequence++, 'tool_execution_update', {
        toolCallId: id,
        partialResult: { progress: update },
      }))
    }
    scheduler.push(event(sequence++, 'tool_execution_end', { toolCallId: id, result: { ok: true }, isError: false }))
  }
  scheduler.flush()
  const pushMs = performance.now() - startedAt
  const visibleDiagnostics = scheduler.snapshot()

  hidden = true
  scheduler.visibilityChanged()
  for (let index = 0; index < 5_000; index += 1) {
    scheduler.push(event(sequence++, 'message_update', {
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'b' },
    }))
  }
  scheduler.flush()
  const hiddenDiagnostics = scheduler.snapshot()
  scheduler.dispose()

  const deliveredRatio = hiddenDiagnostics.deliveredEvents / hiddenDiagnostics.ingressEvents
  const result = {
    benchmark: 'pi-live-scheduler',
    deltaEvents,
    toolCalls,
    ingressEvents: hiddenDiagnostics.ingressEvents,
    deliveredEvents: hiddenDiagnostics.deliveredEvents,
    coalescedEvents: hiddenDiagnostics.coalescedEvents,
    maxQueueDepth: hiddenDiagnostics.maxQueueDepth,
    batches,
    delivered,
    pushMs,
    deliveredRatio,
    visibleHiddenFlag: visibleDiagnostics.hidden,
    hiddenHiddenFlag: hiddenDiagnostics.hidden,
    budgetPushMs,
    budgetDeliveredRatio,
  }

  console.log(`[AgentLens perf] Pi Live Scheduler ingress=${result.ingressEvents} delivered=${result.deliveredEvents} coalesced=${result.coalescedEvents} maxQueue=${result.maxQueueDepth} push=${pushMs.toFixed(2)}ms ratio=${(deliveredRatio * 100).toFixed(2)}%`)
  console.log(JSON.stringify(result))

  if (visibleDiagnostics.hidden) throw new Error('前台调度诊断错误地标记为后台')
  if (!hiddenDiagnostics.hidden) throw new Error('Page Visibility 切换后未进入后台降频状态')
  if (pushMs > budgetPushMs) throw new Error(`Pi Live 高频事件入队 ${pushMs.toFixed(2)}ms 超过预算 ${budgetPushMs}ms`)
  if (deliveredRatio > budgetDeliveredRatio) throw new Error(`Pi Live 事件交付比 ${(deliveredRatio * 100).toFixed(2)}% 超过预算 ${(budgetDeliveredRatio * 100).toFixed(2)}%，背压合并不足`)
  if (hiddenDiagnostics.coalescedEvents <= deltaEvents) throw new Error('Pi Live 高频 delta 未形成足够合并')
} finally {
  if (originalDocument === undefined) delete globalRecord.document
  else globalRecord.document = originalDocument
  if (originalRaf === undefined) delete globalRecord.requestAnimationFrame
  else globalRecord.requestAnimationFrame = originalRaf
  if (originalCancelRaf === undefined) delete globalRecord.cancelAnimationFrame
  else globalRecord.cancelAnimationFrame = originalCancelRaf
}
