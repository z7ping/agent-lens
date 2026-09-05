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

export function createProgressiveHistoryStages(startedAt: number): ProgressiveHistoryStage[] {
  const activeSince = new Date(startedAt - HOT_HISTORY_WINDOW_MS).toISOString()
  return [
    { id: 'latest', label: '最新 1 个会话', window: { sessionLimit: 1 } },
    { id: 'recent', label: '最近 10 个会话', window: { sessionLimit: 10 } },
    { id: 'hot-window', label: '最近 7 天', window: { activeSince } },
  ]
}

/** Parser Replay 完全退出启动链路；保留 API 仅用于明确表达“启动期 0 Replay”。 */
export function createParserReplayStages(_startedAt: number): ParserReplayStage[] {
  return []
}

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
  // Unknown means we cannot prove there is room to expand. Fail closed until the
  // Data Runtime/health snapshot recovers. Exceeded similarly allows only live
  // capture and shrink-oriented maintenance; no historical ingestion grows the DB.
  if (state === 'exceeded' || state === 'unknown') return []
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
