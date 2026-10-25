import type { SourceHistoryWindow } from '@agent-lens/core'

const HOT_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000

export interface ProgressiveHistoryStage {
  id: 'latest' | 'recent' | 'hot-window'
  label: string
  window: SourceHistoryWindow
}
export interface ParserReplayStage {
  id: 'recent' | 'hot-window' | 'all'
  label: string
  window?: SourceHistoryWindow
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function createProgressiveHistoryStages(startedAt: number): ProgressiveHistoryStage[] {
  const activeSince = new Date(startedAt - HOT_HISTORY_WINDOW_MS).toISOString()
  return [
    { id: 'latest', label: '最新 1 个会话', window: { sessionLimit: 1 } },
    { id: 'recent', label: '最近 10 个会话', window: { sessionLimit: 10 } },
    { id: 'hot-window', label: '最近 7 天', window: { activeSince } },
  ]
}

export function startupHistoryStage(
  stages: readonly ProgressiveHistoryStage[],
): ProgressiveHistoryStage | undefined {
  return stages.find(stage => stage.id === 'latest')
}

export function deferredHistoryStages(
  stages: readonly ProgressiveHistoryStage[],
): ProgressiveHistoryStage[] {
  return stages.filter(stage => stage.id !== 'latest')
}

export function createParserReplayMaintenanceStages(startedAt: number): ParserReplayStage[] {
  const activeSince = new Date(startedAt - HOT_HISTORY_WINDOW_MS).toISOString()
  return [
    { id: 'hot-window', label: '最近 7 天', window: { activeSince } },
    { id: 'all', label: '全部已持久化历史' },
  ]
}

/** Each certified native Installation must arbitrate write ownership before
 * Runtime Capture. Legacy targets keep their existing combined startup and
 * never create one asynchronous startup task per unrelated installation.
 * Preserve target ordering even when certification is mixed.
 */
export function nativeCaptureStartupBatches<T>(
  targets: readonly T[], requiresNativeClaim: (target: T) => boolean,
): T[][] {
  const batches: T[][]=[]
  for (const target of targets) {
    if (requiresNativeClaim(target)) {
      batches.push([target])
    } else {
      const previous=batches.at(-1)
      if (previous && !requiresNativeClaim(previous[0]!)) previous.push(target)
      else batches.push([target])
    }
  }
  return batches
}

export type StorageCapacityState = 'healthy' | 'approaching' | 'exceeded' | 'unknown'

export function storageCapacityState(details: Readonly<Record<string, unknown>> | undefined): StorageCapacityState {
  const dataGrowth = asRecord(details?.dataGrowth)
  const capacity = asRecord(dataGrowth.capacity)
  const state = capacity.state
  return state === 'healthy' || state === 'approaching' || state === 'exceeded' ? state : 'unknown'
}

export function stagesAllowedByCapacity(
  stages: readonly ProgressiveHistoryStage[],
  state: StorageCapacityState,
): ProgressiveHistoryStage[] {
  // 容量受限时禁止历史扩张，但仍保留严格有界的 latest 发现能力。
  // Source 是否可见不能依赖数据库是否有空间继续回填 recent / hot-window。
  if (state === 'exceeded' || state === 'unknown') return stages.filter(stage => stage.id === 'latest')
  if (state === 'approaching') return stages.filter(stage => stage.id !== 'hot-window')
  return [...stages]
}

export function parserReplayMaintenanceStagesAllowedByCapacity(
  stages: readonly ParserReplayStage[],
  state: StorageCapacityState,
): ParserReplayStage[] {
  if (state === 'healthy') return [...stages]
  if (state === 'approaching') return stages.filter(stage => stage.id === 'hot-window')
  return []
}

export function yieldToForeground(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => setImmediate(resolve))
}
