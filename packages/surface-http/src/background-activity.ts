import type { MaintenanceJob, SourceRuntimeStatus, StorageService } from '@agent-lens/core'
import type {
  BackgroundActivityItemDto,
  BackgroundActivityKindDto,
  BackgroundActivityResponseDto,
  BackgroundActivityStateDto,
} from '@agent-lens/protocol'

const ACTIVE_LIMIT = 8
const RECENT_LIMIT = 6

function sourceKind(stage: SourceRuntimeStatus['stage']): BackgroundActivityKindDto {
  if (stage === 'detect') return 'source-detect'
  if (stage === 'history') return 'source-history'
  if (stage === 'runtime') return 'source-runtime'
  return 'source-assets'
}

function sourceState(state: SourceRuntimeStatus['state']): BackgroundActivityStateDto | null {
  if (state === 'running') return 'running'
  if (state === 'healthy') return 'completed'
  if (state === 'degraded') return 'degraded'
  if (state === 'failed') return 'failed'
  return null
}

function sourceUpdatedAt(status: SourceRuntimeStatus): string | undefined {
  if (status.state === 'failed' || status.state === 'degraded') {
    return status.lastErrorAt ?? status.lastStartedAt
  }
  if (status.state === 'healthy') return status.lastSuccessAt ?? status.lastStartedAt
  return status.lastStartedAt
}

function sourceItem(status: SourceRuntimeStatus, fallbackTime: string): BackgroundActivityItemDto | null {
  // Runtime capture is long-lived. Once healthy, later successful events keep refreshing
  // lastSuccessAt, so treating that state as a completed background task would create noise.
  if (status.stage === 'runtime' && status.state === 'healthy') return null

  const state = sourceState(status.state)
  if (!state) return null
  const updatedAt = sourceUpdatedAt(status)
  if (state !== 'running' && !updatedAt) return null
  return {
    id: `source:${status.sourceId}:${status.installationId}:${status.runtimeProfileId ?? 'default'}:${status.stage}`,
    kind: sourceKind(status.stage),
    state,
    sourceId: status.sourceId,
    ...(status.lastErrorSummary ? { errorSummary: status.lastErrorSummary } : {}),
    ...(status.lastStartedAt ? { startedAt: status.lastStartedAt } : {}),
    updatedAt: updatedAt ?? fallbackTime,
    ...(state === 'completed' && updatedAt ? { completedAt: updatedAt } : {}),
  }
}

function maintenanceItem(job: MaintenanceJob): BackgroundActivityItemDto {
  return {
    id: job.id,
    kind: job.type,
    state: job.state,
    scope: job.scope,
    ...(job.errorSummary ? { errorSummary: job.errorSummary } : {}),
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    updatedAt: job.updatedAt,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
  }
}

function timestamp(item: BackgroundActivityItemDto): number {
  const value = Date.parse(item.updatedAt)
  return Number.isFinite(value) ? value : 0
}

function activeRank(item: BackgroundActivityItemDto): number {
  if (item.state === 'running') return 0
  if (item.state === 'pending') return 1
  return 2
}

export async function readBackgroundActivity(storage: StorageService): Promise<BackgroundActivityResponseDto> {
  const generatedAt = new Date().toISOString()
  const [jobs, sourceStatuses] = await Promise.all([
    storage.maintenanceJobs?.list() ?? Promise.resolve([]),
    storage.sourceRuntimeStatus?.list() ?? Promise.resolve([]),
  ])

  const sourceItems = sourceStatuses
    .map(status => sourceItem(status, generatedAt))
    .filter((item): item is BackgroundActivityItemDto => item !== null)
  const maintenanceItems = jobs.map(maintenanceItem)

  const active = [...sourceItems, ...maintenanceItems]
    .filter(item => item.state === 'running' || item.state === 'pending')
    .sort((left, right) => activeRank(left) - activeRank(right) || timestamp(left) - timestamp(right) || left.id.localeCompare(right.id))
    .slice(0, ACTIVE_LIMIT)

  const recent = [...sourceItems, ...maintenanceItems]
    .filter(item => item.state === 'completed' || item.state === 'failed' || item.state === 'degraded' || item.state === 'paused')
    .sort((left, right) => timestamp(right) - timestamp(left) || left.id.localeCompare(right.id))
    .slice(0, RECENT_LIMIT)

  return { generatedAt, active, recent }
}
