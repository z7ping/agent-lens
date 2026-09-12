import type { BackgroundActivityItemDto, BackgroundActivityResponseDto } from '@agent-lens/protocol'
import { translateProduct } from '../i18n/runtime'

export type BackgroundActivityTone = 'active' | 'success' | 'warning' | 'idle'

function projectionLabel(scope: string | undefined, active: boolean): string {
  if (scope?.includes('tool-usage')) return translateProduct(active ? 'common:backgroundActivity.projectionToolActive' : 'common:backgroundActivity.projectionToolDone')
  if (scope?.includes('unknown-observation')) return translateProduct(active ? 'common:backgroundActivity.projectionUnknownActive' : 'common:backgroundActivity.projectionUnknownDone')
  if (scope?.includes('session-summary')) return translateProduct(active ? 'common:backgroundActivity.projectionSessionActive' : 'common:backgroundActivity.projectionSessionDone')
  return translateProduct(active ? 'common:backgroundActivity.projectionDefaultActive' : 'common:backgroundActivity.projectionDefaultDone')
}

export function backgroundActivityLabel(
  item: BackgroundActivityItemDto,
  sourceName = item.sourceId ?? translateProduct('common:backgroundActivity.genericAgent'),
  active = item.state === 'running' || item.state === 'pending',
): string {
  if (item.kind === 'source-detect') return translateProduct(active ? 'common:backgroundActivity.sourceDetectActive' : 'common:backgroundActivity.sourceDetectDone', { source: sourceName })
  if (item.kind === 'source-history') return translateProduct(active ? 'common:backgroundActivity.sourceHistoryActive' : 'common:backgroundActivity.sourceHistoryDone', { source: sourceName })
  if (item.kind === 'source-runtime') return translateProduct(active ? 'common:backgroundActivity.sourceRuntimeActive' : 'common:backgroundActivity.sourceRuntimeDone', { source: sourceName })
  if (item.kind === 'source-assets') return translateProduct(active ? 'common:backgroundActivity.sourceAssetsActive' : 'common:backgroundActivity.sourceAssetsDone', { source: sourceName })
  if (item.kind === 'deferred-indexes') return translateProduct(active ? 'common:backgroundActivity.deferredIndexesActive' : 'common:backgroundActivity.deferredIndexesDone')
  if (item.kind === 'projection-rebuild') return projectionLabel(item.scope, active)
  if (item.kind === 'parser-replay') return translateProduct(active ? 'common:backgroundActivity.parserReplayActive' : 'common:backgroundActivity.parserReplayDone')
  if (item.kind === 'source-record-compression') return translateProduct(active ? 'common:backgroundActivity.compressionActive' : 'common:backgroundActivity.compressionDone')
  if (item.kind === 'retention-purge') return translateProduct(active ? 'common:backgroundActivity.retentionActive' : 'common:backgroundActivity.retentionDone')
  return translateProduct(active ? 'common:backgroundActivity.databaseActive' : 'common:backgroundActivity.databaseDone')
}

function recentAgeMs(item: BackgroundActivityItemDto, now: number): number {
  const time = Date.parse(item.completedAt ?? item.updatedAt)
  return Number.isFinite(time) ? Math.max(0, now - time) : Number.POSITIVE_INFINITY
}

export function summarizeBackgroundActivity(
  response: BackgroundActivityResponseDto | null,
  now = Date.now(),
): { tone: BackgroundActivityTone; label: string } {
  const primary = response?.active[0]
  if (primary) {
    const suffix = response!.active.length > 1 ? translateProduct('common:backgroundActivity.moreActive', { count: response!.active.length - 1 }) : ''
    return { tone: 'active', label: `${backgroundActivityLabel(primary)}${suffix}` }
  }

  const recentProblem = response?.recent.find(item =>
    (item.state === 'failed' || item.state === 'degraded') && recentAgeMs(item, now) <= 10 * 60_000,
  )
  if (recentProblem) return { tone: 'warning', label: translateProduct('common:backgroundActivity.taskWarning') }

  const recentSuccess = response?.recent.find(item =>
    item.state === 'completed' && recentAgeMs(item, now) <= 20_000,
  )
  if (recentSuccess) return { tone: 'success', label: translateProduct('common:backgroundActivity.taskSuccess') }

  return { tone: 'idle', label: translateProduct('common:backgroundActivity.idle') }
}
