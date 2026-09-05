import type { SourceHistoryWindow } from '@agent-lens/core'

const HOT_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000

export interface ProgressiveHistoryStage {
  id: 'latest' | 'recent' | 'hot-window'
  label: string
  window: SourceHistoryWindow
}

export interface ParserReplayStage {
  id: 'hot-window' | 'all'
  label: string
  window?: SourceHistoryWindow
}

export function createProgressiveHistoryStages(startedAt: number): ProgressiveHistoryStage[] {
  const activeSince = new Date(startedAt - HOT_HISTORY_WINDOW_MS).toISOString()
  return [
    // “最新/最近”描述的是按来源自身最近活动排序后的会话数量，不能再被热窗口裁掉。
    // 否则一个超过 7 天未使用的来源会在冷启动时表现为“没有任何历史”。
    { id: 'latest', label: '最新 1 个会话', window: { sessionLimit: 1 } },
    { id: 'recent', label: '最近 10 个会话', window: { sessionLimit: 10 } },
    { id: 'hot-window', label: '最近 7 天', window: { activeSince } },
  ]
}

/** Parser Replay 完全退出启动链路，只能由空闲维护调度执行。 */
export function createParserReplayMaintenanceStages(startedAt: number): ParserReplayStage[] {
  const activeSince = new Date(startedAt - HOT_HISTORY_WINDOW_MS).toISOString()
  return [
    { id: 'hot-window', label: '最近 7 天', window: { activeSince } },
    { id: 'all', label: '全部已持久化历史' },
  ]
}

export type StorageCapacityState = 'healthy' | 'approaching' | 'exceeded' | 'unknown'

export function storageCapacityState(details: Readonly<Record<string, unknown>> | undefined): StorageCapacityState {
  const dataGrowth = details?.dataGrowth
  if (!dataGrowth || typeof dataGrowth !== 'object' || Array.isArray(dataGrowth)) return 'unknown'
  const capacity = (dataGrowth as Record<string, unknown>).capacity
  if (!capacity || typeof capacity !== 'object' || Array.isArray(capacity)) return 'unknown'
  const state = (capacity as Record<string, unknown>).state
  return state === 'healthy' || state === 'approaching' || state === 'exceeded' ? state : 'unknown'
}

export function stagesAllowedByCapacity(
  stages: readonly ProgressiveHistoryStage[],
  state: StorageCapacityState,
): ProgressiveHistoryStage[] {
  if (state === 'exceeded') return stages.filter(stage => stage.id === 'latest')
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

export const progressiveHistoryInternals = {
  HOT_HISTORY_WINDOW_MS,
}
