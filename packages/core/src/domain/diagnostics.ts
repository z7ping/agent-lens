import type { AgentInstallationId, RuntimeProfileId } from './common'

export type SourceRuntimeStage = 'detect' | 'history' | 'runtime' | 'assets'
export type SourceRuntimeState = 'idle' | 'running' | 'healthy' | 'degraded' | 'failed' | 'disabled'

export type SourceSyncStepId = 'detected' | 'waiting' | 'scanning' | 'processing' | 'checkpoint' | 'finished'
export type SourceSyncState = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface SourceSyncStep {
  id: SourceSyncStepId
  state: SourceSyncState
  startedAt?: string
  completedAt?: string
}
/** 同步控制面的观测摘要；会话事实仍通过 Canonical Pipeline 入库。 */
export interface SourceSyncProgress {
  version: 1
  kind: 'source-history-sync'
  runId: string
  ownerStartedAt: string
  state: SourceSyncState
  updatedAt: string
  heartbeatAt: string
  steps: SourceSyncStep[]
  records: number
  created: number
  merged: number
  unchanged: number
  discoveredUnits?: number
  processedUnits?: number
  currentUnit?: string
}
export interface SourceHistoryProgressUpdate {
  phase: 'scanning' | 'processing'
  discoveredUnits?: number
  processedUnits?: number
  currentUnit?: string
}

export interface SourceRuntimeStatus {
  sourceId: string
  installationId: AgentInstallationId
  runtimeProfileId?: RuntimeProfileId
  stage: SourceRuntimeStage
  state: SourceRuntimeState
  lastStartedAt?: string
  lastSuccessAt?: string
  lastErrorAt?: string
  errorCount: number
  lastErrorSummary?: string
  checkpointSummary?: string
}

export type SourceRuntimeStatusInput = SourceRuntimeStatus
