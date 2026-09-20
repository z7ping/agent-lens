import type { LogicalSessionId, ObservationId } from '../domain/common'
import type { CanonicalObservation } from '../domain/observation'

export type TaskFileChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown'
export type TaskFileChangeEvidence = 'tool' | 'filesystem' | 'git'
export type TaskFileChangeConfidence = 'exact' | 'high' | 'medium' | 'low'

export interface TaskFileChangeCandidate {
  logicalSessionId: LogicalSessionId
  observationId: ObservationId
  path: string
  oldPath?: string
  operation: 'write' | 'delete' | 'rename' | 'unknown'
  observedAt: string
  evidence: TaskFileChangeEvidence
  confidence: TaskFileChangeConfidence
}

export interface TaskFileChangeRecord {
  logicalSessionId: LogicalSessionId
  path: string
  changeType: TaskFileChangeType
  oldPath?: string
  additions?: number
  deletions?: number
  firstChangedAt: string
  lastChangedAt: string
  evidence: TaskFileChangeEvidence[]
  confidence: TaskFileChangeConfidence
}

/**
 * Read model for task-level file changes. Implementations may combine observed
 * tool evidence with filesystem/Git reconciliation, but must never present a
 * guessed shell side effect as an exact file change.
 */
export interface TaskFileChangeReader {
  listBySession(logicalSessionId: LogicalSessionId): Promise<TaskFileChangeRecord[]>
}

/** Writable/rebuildable projection contract. */
export interface TaskFileChangeProjectionStore extends TaskFileChangeReader {
  applyObservation(observation: CanonicalObservation): Promise<void>
  rebuild(input?: { logicalSessionId?: LogicalSessionId; signal?: AbortSignal }): Promise<void>
}
