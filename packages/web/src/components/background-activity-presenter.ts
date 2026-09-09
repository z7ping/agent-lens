import type { BackgroundActivityItemDto, BackgroundActivityResponseDto } from '@agent-lens/protocol'

export type BackgroundActivityTone = 'active' | 'success' | 'warning' | 'idle'

function projectionLabel(scope: string | undefined, active: boolean): string {
  if (scope?.includes('tool-usage')) return active ? '正在整理工具使用数据' : '工具使用数据整理'
  if (scope?.includes('unknown-observation')) return active ? '正在修复历史数据' : '历史数据修复'
  if (scope?.includes('session-summary')) return active ? '正在整理会话索引' : '会话索引整理'
  return active ? '正在更新数据视图' : '数据视图更新'
}

export function backgroundActivityLabel(
  item: BackgroundActivityItemDto,
  sourceName = item.sourceId ?? '智能体',
  active = item.state === 'running' || item.state === 'pending',
): string {
  if (item.kind === 'source-detect') return active ? `正在检测 ${sourceName}` : `${sourceName} 检测`
  if (item.kind === 'source-history') return active ? `正在同步 ${sourceName} 历史会话` : `${sourceName} 历史会话同步`
  if (item.kind === 'source-runtime') return active ? `正在启动 ${sourceName} 实时采集` : `${sourceName} 实时采集启动`
  if (item.kind === 'source-assets') return active ? `正在扫描 ${sourceName} 资产` : `${sourceName} 资产扫描`
  if (item.kind === 'deferred-indexes') return active ? '正在建立数据索引' : '数据索引建立'
  if (item.kind === 'projection-rebuild') return projectionLabel(item.scope, active)
  if (item.kind === 'parser-replay') return active ? '正在重新解析历史会话' : '历史会话重新解析'
  if (item.kind === 'source-record-compression') return active ? '正在压缩历史数据' : '历史数据压缩'
  if (item.kind === 'retention-purge') return active ? '正在清理历史数据' : '历史数据清理'
  return active ? '正在整理本地数据库' : '本地数据库整理'
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
    const suffix = response!.active.length > 1 ? ` · 另有 ${response!.active.length - 1} 项` : ''
    return { tone: 'active', label: `${backgroundActivityLabel(primary)}${suffix}` }
  }

  const recentProblem = response?.recent.find(item =>
    (item.state === 'failed' || item.state === 'degraded') && recentAgeMs(item, now) <= 10 * 60_000,
  )
  if (recentProblem) return { tone: 'warning', label: '后台任务异常' }

  const recentSuccess = response?.recent.find(item =>
    item.state === 'completed' && recentAgeMs(item, now) <= 20_000,
  )
  if (recentSuccess) return { tone: 'success', label: '后台处理完成' }

  return { tone: 'idle', label: '后台活动' }
}
