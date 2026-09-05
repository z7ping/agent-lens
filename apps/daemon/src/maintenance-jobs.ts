import type {
  JsonValue,
  MaintenanceJob,
  MaintenanceJobStore,
  MaintenanceJobType,
} from '@agent-lens/core'

export const MAINTENANCE_PRIORITY = {
  projection: 40,
  deferredIndexes: 45,
  replay: 50,
  compression: 60,
  cleanup: 70,
} as const

const TRANSIENT_RETRY_LIMIT = 5
const TRANSIENT_RETRY_DELAY_MS = 1_000

export interface MaintenanceJobSpec {
  id: string
  type: MaintenanceJobType
  scope: string
  priority: number
  progress?: JsonValue
}

export interface MaintenanceJobContext {
  readonly signal: AbortSignal
  /** Persisted progress from the latest successful batch, if any. */
  readonly initialProgress?: JsonValue
  report(progress: JsonValue): Promise<boolean>
}

export interface MaintenanceJobRunResult<T> {
  status: 'completed' | 'paused' | 'contended'
  value?: T
  job: MaintenanceJob
}

function errorSummary(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 2000)
}

function transientDataRuntimeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Data Runtime/i.test(message)
    && /(unavailable|not started|timed out|worker|request limit|degraded)/i.test(message)
}

function waitForRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer.unref?.()
  })
}

export async function runMaintenanceJob<T>(
  store: MaintenanceJobStore | undefined,
  spec: MaintenanceJobSpec,
  signal: AbortSignal,
  operation: (context: MaintenanceJobContext) => Promise<T>,
  completeProgress?: (value: T) => JsonValue,
): Promise<MaintenanceJobRunResult<T> | null> {
  if (!store) {
    await operation({ signal, initialProgress: spec.progress, report: async () => true })
    return null
  }

  let job = await store.ensure(spec)
  if (signal.aborted) {
    const paused = await store.transition(job.id, job.revision, { state: 'paused' })
    return { status: 'paused', job: paused ?? job }
  }

  const running = await store.transition(job.id, job.revision, {
    state: 'running',
    ...(job.progress === undefined && spec.progress !== undefined ? { progress: spec.progress } : {}),
  })
  if (!running) {
    const latest = await store.get(job.id)
    return { status: 'contended', job: latest ?? job }
  }
  job = running

  const createContext = (): MaintenanceJobContext => ({
    signal,
    ...(job.progress === undefined ? {} : { initialProgress: job.progress }),
    async report(progress) {
      const next = await store.transition(job.id, job.revision, { state: 'running', progress })
      if (!next) return false
      job = next
      return true
    },
  })

  let transientAttempts = 0
  while (!signal.aborted) {
    try {
      const value = await operation(createContext())
      if (signal.aborted) {
        const paused = await store.transition(job.id, job.revision, { state: 'paused' })
        return { status: 'paused', value, job: paused ?? job }
      }
      const completed = await store.transition(job.id, job.revision, {
        state: 'completed',
        ...(completeProgress ? { progress: completeProgress(value) } : {}),
      })
      if (!completed) {
        const latest = await store.get(job.id)
        return { status: 'contended', value, job: latest ?? job }
      }
      return { status: 'completed', value, job: completed }
    } catch (error) {
      if (transientDataRuntimeError(error) && transientAttempts < TRANSIENT_RETRY_LIMIT) {
        transientAttempts += 1
        await waitForRetry(signal)
        if (signal.aborted) break
        const latest = await store.get(job.id)
        if (!latest || latest.revision !== job.revision) {
          return { status: 'contended', job: latest ?? job }
        }
        job = latest
        continue
      }

      const failed = await store.transition(job.id, job.revision, {
        state: 'failed',
        errorSummary: errorSummary(error),
      })
      job = failed ?? job
      throw error
    }
  }

  const paused = await store.transition(job.id, job.revision, { state: 'paused' })
  return { status: 'paused', job: paused ?? job }
}

export const maintenanceJobInternals = {
  transientDataRuntimeError,
  TRANSIENT_RETRY_LIMIT,
  TRANSIENT_RETRY_DELAY_MS,
}
