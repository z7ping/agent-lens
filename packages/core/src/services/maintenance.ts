import type { JsonValue } from '../domain/common'

export type MaintenanceJobType =
  | 'deferred-indexes'
  | 'projection-rebuild'
  | 'parser-replay'
  | 'source-record-compression'
  | 'retention-purge'
  | 'vacuum'

export type MaintenanceJobState = 'pending' | 'running' | 'paused' | 'completed' | 'failed'

export interface MaintenanceJob {
  id: string
  type: MaintenanceJobType
  scope: string
  priority: number
  state: MaintenanceJobState
  revision: number
  progress?: JsonValue
  errorSummary?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
}

export interface MaintenanceJobEnsureInput {
  id: string
  type: MaintenanceJobType
  scope: string
  priority: number
  progress?: JsonValue
}

export interface MaintenanceJobTransitionInput {
  state: MaintenanceJobState
  progress?: JsonValue
  errorSummary?: string
}

/**
 * Persistent control-plane state for slow, resumable storage maintenance.
 * Actual work remains owned by the data runtime; revision is the CAS boundary.
 */
export interface MaintenanceJobStore {
  ensure(input: MaintenanceJobEnsureInput): Promise<MaintenanceJob>
  get(id: string): Promise<MaintenanceJob | null>
  list(states?: readonly MaintenanceJobState[]): Promise<MaintenanceJob[]>
  transition(
    id: string,
    expectedRevision: number,
    input: MaintenanceJobTransitionInput,
  ): Promise<MaintenanceJob | null>
}
