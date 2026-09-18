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

export interface SessionSummaryProjectionRunState {
  /** Existing materialized rows may be served immediately even when they need repair. */
  materialized: boolean
  /** Previous process reached a controlled flush + clean checkpoint. */
  cleanBeforeRun: boolean
  /** Background repair is required before this process can mark the projection clean. */
  needsRepair: boolean
}

export async function beginSessionSummaryProjectionRun(
  storage: ProjectionReadinessStorage,
): Promise<SessionSummaryProjectionRunState> {
  try {
    const marker = await storage.checkpoints.get<SessionSummaryCleanMarker>(
      CHECKPOINT_SCOPE,
      CHECKPOINT_KEY,
    )
    const cleanBeforeRun = marker?.version === 1 && marker.clean === true

    // Mark this process dirty before any source can commit new Canonical data. A crash
    // anywhere after this point therefore requires repair, but existing materialized
    // rows remain a usable derived read model while that repair runs in the background.
    await storage.checkpoints.clear(CHECKPOINT_SCOPE, CHECKPOINT_KEY)

    const projection = storage.sessionSummaryProjection
    const materialized = projection ? await projection.isMaterialized() : false
    return {
      materialized,
      cleanBeforeRun,
      needsRepair: !cleanBeforeRun || !materialized,
    }
  } catch {
    // Data Runtime may be recovering while the control plane is already online.
    // Treat projection readiness as unknown/dirty rather than taking Daemon down.
    return {
      materialized: false,
      cleanBeforeRun: false,
      needsRepair: true,
    }
  }
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
