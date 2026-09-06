import type {
  DataRuntimeForegroundQueueHealthDto,
  DataRuntimeHealthDto,
  DataRuntimeWorkerHealthDto,
} from '@agent-lens/protocol'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nonNegativeInteger(value: unknown): value is number {
  return finiteNumber(value) && Number.isSafeInteger(value) && value >= 0
}

function workerHealth(value: unknown): DataRuntimeWorkerHealthDto | undefined {
  const source = record(value)
  if (!source) return undefined
  if (source.state !== 'starting' && source.state !== 'ready' && source.state !== 'degraded' && source.state !== 'stopped') return undefined
  if (source.role !== 'writer' && source.role !== 'reader') return undefined
  if (!nonNegativeInteger(source.protocolVersion)
    || !nonNegativeInteger(source.pending)
    || !nonNegativeInteger(source.maxPending)
    || !nonNegativeInteger(source.requests)
    || !nonNegativeInteger(source.completed)
    || !nonNegativeInteger(source.timeouts)) return undefined

  const duration = record(source.durationMs)
  if (!duration
    || !finiteNumber(duration.last)
    || !finiteNumber(duration.max)
    || !finiteNumber(duration.p50)
    || !finiteNumber(duration.p95)
    || !finiteNumber(duration.p99)) return undefined

  if (source.livenessFailures !== undefined && !nonNegativeInteger(source.livenessFailures)) return undefined
  if (source.lastError !== undefined && typeof source.lastError !== 'string') return undefined

  return {
    state: source.state,
    role: source.role,
    protocolVersion: source.protocolVersion,
    pending: source.pending,
    maxPending: source.maxPending,
    requests: source.requests,
    completed: source.completed,
    timeouts: source.timeouts,
    ...(source.livenessFailures === undefined ? {} : { livenessFailures: source.livenessFailures }),
    ...(source.lastError === undefined ? {} : { lastError: source.lastError }),
    durationMs: {
      last: duration.last,
      max: duration.max,
      p50: duration.p50,
      p95: duration.p95,
      p99: duration.p99,
    },
  }
}

function foregroundQueueHealth(value: unknown): DataRuntimeForegroundQueueHealthDto | undefined {
  const source = record(value)
  if (!source) return undefined
  if (!nonNegativeInteger(source.queued)
    || !nonNegativeInteger(source.maxQueued)
    || !nonNegativeInteger(source.maxQueue)
    || !nonNegativeInteger(source.overloads)
    || !nonNegativeInteger(source.queueTimeouts)
    || !finiteNumber(source.waitBudgetMs)
    || source.waitBudgetMs < 0) return undefined
  return {
    queued: source.queued,
    maxQueued: source.maxQueued,
    maxQueue: source.maxQueue,
    overloads: source.overloads,
    queueTimeouts: source.queueTimeouts,
    waitBudgetMs: source.waitBudgetMs,
  }
}

export function parseDataRuntimeHealth(value: unknown): DataRuntimeHealthDto | undefined {
  const source = record(value)
  if (!source || typeof source.ok !== 'boolean' || typeof source.recovering !== 'boolean') return undefined
  const writer = workerHealth(source.writer)
  const reader = workerHealth(source.reader)
  if (!writer || writer.role !== 'writer' || !reader || reader.role !== 'reader') return undefined

  let readers: DataRuntimeWorkerHealthDto[] | undefined
  if (source.readers !== undefined) {
    if (!Array.isArray(source.readers)) return undefined
    readers = []
    for (const item of source.readers) {
      const parsed = workerHealth(item)
      if (!parsed || parsed.role !== 'reader') return undefined
      readers.push(parsed)
    }
  }

  const maintenanceReader = source.maintenanceReader === undefined
    ? undefined
    : workerHealth(source.maintenanceReader)
  if (source.maintenanceReader !== undefined && (!maintenanceReader || maintenanceReader.role !== 'reader')) return undefined

  const foregroundQueue = source.foregroundQueue === undefined
    ? undefined
    : foregroundQueueHealth(source.foregroundQueue)
  if (source.foregroundQueue !== undefined && !foregroundQueue) return undefined

  return {
    ok: source.ok,
    recovering: source.recovering,
    writer,
    reader,
    ...(readers === undefined ? {} : { readers }),
    ...(maintenanceReader === undefined ? {} : { maintenanceReader }),
    ...(foregroundQueue === undefined ? {} : { foregroundQueue }),
  }
}
