import type { BackgroundActivityItemDto, BackgroundActivityResponseDto } from '@agent-lens/protocol'
import { translateProduct } from '../i18n/runtime'

export type BackgroundActivityTone = 'active' | 'warning' | 'idle'

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
  if (item.kind === 'native-index') return translateProduct(active ? 'common:backgroundActivity.nativeIndexActive' : 'common:backgroundActivity.nativeIndexDone')
  if (item.kind === 'source-runtime') return translateProduct(active ? 'common:backgroundActivity.sourceRuntimeActive' : 'common:backgroundActivity.sourceRuntimeDone', { source: sourceName })
  if (item.kind === 'runtime-startup-audit') return translateProduct('common:backgroundActivity.runtimeStartupAudit', { source: sourceName })
  if (item.kind === 'source-assets') return translateProduct(active ? 'common:backgroundActivity.sourceAssetsActive' : 'common:backgroundActivity.sourceAssetsDone', { source: sourceName })
  if (item.kind === 'deferred-indexes') return translateProduct(active ? 'common:backgroundActivity.deferredIndexesActive' : 'common:backgroundActivity.deferredIndexesDone')
  if (item.kind === 'projection-rebuild') return projectionLabel(item.scope, active)
  if (item.kind === 'parser-replay') return translateProduct(active ? 'common:backgroundActivity.parserReplayActive' : 'common:backgroundActivity.parserReplayDone')
  if (item.kind === 'source-record-compression') return translateProduct(active ? 'common:backgroundActivity.compressionActive' : 'common:backgroundActivity.compressionDone')
  if (item.kind === 'retention-purge') return translateProduct(active ? 'common:backgroundActivity.retentionActive' : 'common:backgroundActivity.retentionDone')
  return translateProduct(active ? 'common:backgroundActivity.databaseActive' : 'common:backgroundActivity.databaseDone')
}

export function summarizeBackgroundActivity(
  response: BackgroundActivityResponseDto | null,
): { tone: BackgroundActivityTone; label: string } {
  const primary = response?.active[0]
  if (primary) {
    const suffix = response!.active.length > 1
      ? translateProduct('common:backgroundActivity.moreActive', { count: response!.active.length - 1 }) : ''
    return { tone: 'active', label: backgroundActivityLabel(primary) + suffix }
  }

  // The latest run remains visibly degraded until a newer successful run replaces it.
  const latest = response?.recent[0]
  if (latest && (latest.state === 'failed' || latest.state === 'degraded')) {
    return { tone: 'warning', label: translateProduct('common:backgroundActivity.taskWarning') }
  }

  return { tone: 'idle', label: translateProduct('common:backgroundActivity.idle') }
}
