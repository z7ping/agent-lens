import type { SourceHistoryWindow } from '@agent-lens/core'

const HOT_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000

export interface ProgressiveHistoryStage {
  id: 'latest' | 'recent' | 'hot-window'
  label: string
  window: SourceHistoryWindow
}

export function createProgressiveHistoryStages(startedAt: number): ProgressiveHistoryStage[] {
  const activeSince = new Date(startedAt - HOT_HISTORY_WINDOW_MS).toISOString()
  return [
    { id: 'latest', label: '最新 1 个会话', window: { activeSince, sessionLimit: 1 } },
    { id: 'recent', label: '最近 10 个会话', window: { activeSince, sessionLimit: 10 } },
    { id: 'hot-window', label: '最近 7 天', window: { activeSince } },
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
  return state === 'approaching' || state === 'exceeded'
    ? stages.filter(stage => stage.id !== 'hot-window')
    : [...stages]
}

export function yieldToForeground(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => setImmediate(resolve))
}

export const progressiveHistoryInternals = {
  HOT_HISTORY_WINDOW_MS,
}
