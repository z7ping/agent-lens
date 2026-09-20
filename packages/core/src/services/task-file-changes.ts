import type { LogicalSessionId, ObservationId } from '../domain/common'

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

export interface TaskFileChangeCapture {
  runtimeSessionId: string
  logicalSessionId?: LogicalSessionId
  workspacePath: string
  gitRootPath?: string
  baselineTreeSha?: string
  baselineCapturedAt: string
  finalTreeSha?: string
  checkpointedAt?: string
  finalizedAt?: string
  changes?: TaskFileChangeRecord[]
}

/**
 * Durable capture + rebuildable read model.
 *
 * Capture rows preserve what was known at task time; projection rows are only
 * the fast Task/Review read model and can be reconstructed from finalized
 * captures.
 */
export interface TaskFileChangeProjectionStore extends TaskFileChangeReader {
  putBaseline(capture: TaskFileChangeCapture): Promise<void>
  getByRuntime(runtimeSessionId: string): Promise<TaskFileChangeCapture | null>
  bindRuntime(runtimeSessionId: string, logicalSessionId: LogicalSessionId): Promise<void>
  checkpointRuntime(
    runtimeSessionId: string,
    input: {
      logicalSessionId: LogicalSessionId
      finalTreeSha?: string
      checkpointedAt: string
      changes: TaskFileChangeRecord[]
    },
  ): Promise<void>
  finalizeRuntime(
    runtimeSessionId: string,
    input: {
      logicalSessionId: LogicalSessionId
      finalTreeSha?: string
      finalizedAt: string
      changes: TaskFileChangeRecord[]
    },
  ): Promise<void>
  mergeObservedSession(
    logicalSessionId: LogicalSessionId,
    changes: TaskFileChangeRecord[],
  ): Promise<boolean>
  replaceObservedSession(
    logicalSessionId: LogicalSessionId,
    changes: TaskFileChangeRecord[],
  ): Promise<boolean>
  replaceSession(
    logicalSessionId: LogicalSessionId,
    changes: TaskFileChangeRecord[],
  ): Promise<void>
  rebuild(input?: { logicalSessionId?: LogicalSessionId; signal?: AbortSignal }): Promise<void>
}
