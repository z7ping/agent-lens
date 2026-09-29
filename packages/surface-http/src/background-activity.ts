import type { MaintenanceJob, SourceRuntimeStatus, SourceSyncProgress, StorageService } from '@agent-lens/core'
import type {
  BackgroundActivityItemDto,
  BackgroundActivityKindDto,
  BackgroundActivityResponseDto,
  BackgroundActivityStateDto,
} from '@agent-lens/protocol'

const ACTIVE_LIMIT = 8
const RECENT_LIMIT = 6
const SYNC_STEPS = ['detected', 'waiting', 'scanning', 'processing', 'checkpoint', 'finished']
const SYNC_STATES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted']

function syncProgress(summary: string | undefined): SourceSyncProgress | undefined {
  if (!summary || summary.length > 32_768) return undefined
  try {
    const value = JSON.parse(summary) as SourceSyncProgress
    if (!value || value.version !== 1 || value.kind !== 'source-history-sync'
      || typeof value.runId !== 'string' || !SYNC_STATES.includes(value.state)
      || ![value.ownerStartedAt, value.updatedAt, value.heartbeatAt].every(time => typeof time === 'string' && Number.isFinite(Date.parse(time)))
      || ![value.records, value.created, value.merged, value.unchanged].every(count => Number.isSafeInteger(count) && count >= 0)
      || ![value.discoveredUnits, value.processedUnits].every(count => count === undefined || (Number.isSafeInteger(count) && count >= 0))
      || (value.currentUnit !== undefined && typeof value.currentUnit !== 'string')
      || !Array.isArray(value.steps) || value.steps.length !== SYNC_STEPS.length
      || !value.steps.every((step, index) => step && step.id === SYNC_STEPS[index] && SYNC_STATES.includes(step.state)
        && [step.startedAt, step.completedAt].every(time => time === undefined || (typeof time === 'string' && Number.isFinite(Date.parse(time)))))) return undefined
    return value
  } catch { return undefined }
}

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

function sourceItem(status: SourceRuntimeStatus, fallbackTime: string, runtimeStartedAt?: string): BackgroundActivityItemDto | null {
  // Runtime capture is long-lived. Once healthy, later successful events keep refreshing
  // lastSuccessAt, so treating that state as a completed background task would create noise.
  if (status.stage === 'runtime' && status.state === 'healthy') return null

  const progress = status.stage === 'history' ? syncProgress(status.checkpointSummary) : undefined
  let state: BackgroundActivityStateDto | null = progress?.state ?? sourceState(status.state)
  const oldOwner = runtimeStartedAt && (progress
    ? progress.ownerStartedAt !== runtimeStartedAt
    : status.lastStartedAt && Date.parse(status.lastStartedAt) < Date.parse(runtimeStartedAt))
  if (oldOwner && (state === 'running' || state === 'pending')) state = 'interrupted'
  if (!state) return null
  const updatedAt = progress?.updatedAt ?? sourceUpdatedAt(status)
  if (state !== 'running' && !updatedAt) return null
  return {
    id: `source:${status.sourceId}:${status.installationId}:${status.runtimeProfileId ?? 'default'}:${status.stage}`,
    kind: sourceKind(status.stage),
    state,
    sourceId: status.sourceId,
    ...((state === 'failed' || state === 'degraded') && status.lastErrorSummary ? { errorSummary: status.lastErrorSummary } : {}),
    ...(status.lastStartedAt ? { startedAt: status.lastStartedAt } : {}),
    updatedAt: updatedAt ?? fallbackTime,
    ...(state === 'completed' && updatedAt ? { completedAt: updatedAt } : {}),
    ...(progress ? { sync: {
      runId: progress.runId, state: state === 'interrupted' ? 'interrupted' : progress.state, updatedAt: progress.updatedAt, heartbeatAt: progress.heartbeatAt,
      steps: progress.steps.map(step => state === 'interrupted' && step.state === 'running' ? { ...step, state: 'interrupted' as const } : step),
      records: progress.records, created: progress.created, merged: progress.merged, unchanged: progress.unchanged,
      ...(progress.discoveredUnits !== undefined ? { discoveredUnits: progress.discoveredUnits } : {}),
      ...(progress.processedUnits !== undefined ? { processedUnits: progress.processedUnits } : {}),
      ...(progress.currentUnit ? { currentUnit: progress.currentUnit } : {}),
    } } : {}),
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

function startupAuditItem(summary: Awaited<ReturnType<NonNullable<StorageService['sessionSummaries']>['query']>>['items'][number]): BackgroundActivityItemDto {
  return {
    id: `startup-audit:${summary.logicalSessionId}`,
    kind: 'runtime-startup-audit',
    state: 'completed',
    ...(summary.sourceIds[0] ? { sourceId: summary.sourceIds[0] } : {}),
    startedAt: summary.startedAt,
    updatedAt: summary.endedAt,
    completedAt: summary.endedAt,
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

export async function readBackgroundActivity(storage: StorageService, runtimeStartedAt?: string): Promise<BackgroundActivityResponseDto> {
  const generatedAt = new Date().toISOString()
  const [jobs, sourceStatuses, startupAudits] = await Promise.all([
    storage.maintenanceJobs?.list() ?? Promise.resolve([]),
    storage.sourceRuntimeStatus?.list() ?? Promise.resolve([]),
    storage.sessionSummaries?.query({
      limit: RECENT_LIMIT,
      sessionActivities: ['system-activity'],
      leadingObservationKinds: ['runtime.startup'],
    }).then(page => page.items.map(startupAuditItem)) ?? Promise.resolve([]),
  ])

  const sourceItems = sourceStatuses
    .map(status => sourceItem(status, generatedAt, runtimeStartedAt))
    .filter((item): item is BackgroundActivityItemDto => item !== null)
  const maintenanceItems = jobs.map(maintenanceItem)

  const active = [...sourceItems, ...maintenanceItems]
    .filter(item => item.state === 'running' || item.state === 'pending')
    .sort((left, right) => activeRank(left) - activeRank(right) || timestamp(left) - timestamp(right) || left.id.localeCompare(right.id))
    .slice(0, ACTIVE_LIMIT)

  const recent = [...sourceItems, ...maintenanceItems, ...startupAudits]
    .filter(item => item.state === 'completed' || item.state === 'failed' || item.state === 'degraded' || item.state === 'paused' || item.state === 'cancelled' || item.state === 'interrupted')
    .sort((left, right) => timestamp(right) - timestamp(left) || left.id.localeCompare(right.id))
    .slice(0, RECENT_LIMIT)

  const histories = sourceItems.filter(item => item.kind === 'source-history')
  const currentIds = new Set(sourceStatuses.filter(status => runtimeStartedAt && syncProgress(status.checkpointSummary)?.ownerStartedAt === runtimeStartedAt)
    .map(status => `source:${status.sourceId}:${status.installationId}:${status.runtimeProfileId ?? 'default'}:${status.stage}`))
  const grouped = new Map<string, BackgroundActivityItemDto[]>()
  for (const item of histories) {
    const key = item.sourceId ?? ''
    const group = grouped.get(key) ?? []
    group.push(item)
    grouped.set(key, group)
  }
  const sources = [...grouped.values()].flatMap(group => {
    const current = group.filter(item => currentIds.has(item.id))
    return current.length ? current : group.sort((a, b) => timestamp(b) - timestamp(a) || a.id.localeCompare(b.id)).slice(0, 1)
  }).sort((a, b) => activeRank(a) - activeRank(b) || (a.sourceId ?? '').localeCompare(b.sourceId ?? ''))
  return { generatedAt, active, recent, sources }
}
