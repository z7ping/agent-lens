import type {
  CheckpointRepository,
  ProjectionService,
  SessionSummaryProjectionStore,
} from '@agent-lens/core'
import { SESSION_SUMMARY_PROJECTION_ID } from '@agent-lens/projection-session'

const CHECKPOINT_SCOPE = 'runtime'
const CHECKPOINT_KEY = 'projection:session-summary:clean-v1'

interface SessionSummaryCleanMarker {
  version: 1
  clean: true
  markedAt: string
}

export interface ProjectionReadinessStorage {
  checkpoints: Pick<CheckpointRepository, 'get' | 'set' | 'clear'>
  sessionSummaryProjection?: Pick<SessionSummaryProjectionStore, 'isMaterialized'>
}

export async function beginSessionSummaryProjectionRun(
  storage: ProjectionReadinessStorage,
): Promise<boolean> {
  const marker = await storage.checkpoints.get<SessionSummaryCleanMarker>(
    CHECKPOINT_SCOPE,
    CHECKPOINT_KEY,
  )

  // Mark this process dirty before any source can commit new Canonical data. A crash
  // anywhere after this point therefore forces a conservative rebuild next start.
  await storage.checkpoints.clear(CHECKPOINT_SCOPE, CHECKPOINT_KEY)

  if (marker?.version !== 1 || marker.clean !== true) return false
  const projection = storage.sessionSummaryProjection
  return projection ? projection.isMaterialized() : false
}

export async function markSessionSummaryProjectionClean(
  storage: ProjectionReadinessStorage,
  projections: Pick<ProjectionService, 'flush'>,
): Promise<void> {
  await projections.flush(SESSION_SUMMARY_PROJECTION_ID)
  await storage.checkpoints.set<SessionSummaryCleanMarker>(CHECKPOINT_SCOPE, CHECKPOINT_KEY, {
    version: 1,
    clean: true,
    markedAt: new Date().toISOString(),
  })
}

export const projectionReadinessInternals = {
  CHECKPOINT_SCOPE,
  CHECKPOINT_KEY,
}
