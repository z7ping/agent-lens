import type {
  JsonValue,
  MaintenanceJob,
  MaintenanceJobStore,
  MaintenanceJobType,
} from '@agent-lens/core'

export const MAINTENANCE_PRIORITY = {
  projection: 40,
  replay: 50,
  deferredIndexes: 55,
  compression: 60,
  cleanup: 70,
} as const

export interface MaintenanceJobSpec {
  id: string
  type: MaintenanceJobType
  scope: string
  priority: number
  progress?: JsonValue
}

export interface MaintenanceJobContext {
  readonly signal: AbortSignal
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

export async function runMaintenanceJob<T>(
  store: MaintenanceJobStore | undefined,
  spec: MaintenanceJobSpec,
  signal: AbortSignal,
  operation: (context: MaintenanceJobContext) => Promise<T>,
  completeProgress?: (value: T) => JsonValue,
): Promise<MaintenanceJobRunResult<T> | null> {
  if (!store) return null

  let job = await store.ensure(spec)
  if (signal.aborted) {
    const paused = await store.transition(job.id, job.revision, { state: 'paused' })
    return { status: 'paused', job: paused ?? job }
  }

  const running = await store.transition(job.id, job.revision, {
    state: 'running',
    ...(spec.progress === undefined ? {} : { progress: spec.progress }),
  })
  if (!running) {
    const latest = await store.get(job.id)
    return { status: 'contended', job: latest ?? job }
  }
  job = running

  const context: MaintenanceJobContext = {
    signal,
    async report(progress) {
      const next = await store.transition(job.id, job.revision, { state: 'running', progress })
      if (!next) return false
      job = next
      return true
    },
  }

  try {
    const value = await operation(context)
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
    const failed = await store.transition(job.id, job.revision, {
      state: signal.aborted ? 'paused' : 'failed',
      ...(!signal.aborted ? { errorSummary: errorSummary(error) } : {}),
    })
    job = failed ?? job
    if (signal.aborted) return { status: 'paused', job }
    throw error
  }
}
