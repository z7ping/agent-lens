import type { AgentInstallationId, RuntimeProfileId } from './common'

export type SourceRuntimeStage = 'detect' | 'history' | 'runtime' | 'assets'
export type SourceRuntimeState = 'idle' | 'running' | 'healthy' | 'degraded' | 'failed' | 'disabled'

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

export interface SourceRuntimeStatusInput extends SourceRuntimeStatus {}
