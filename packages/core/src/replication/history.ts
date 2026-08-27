import type { HistoryBoundary } from './policy'

export type ReplicationHistoryPhase = 'bootstrap' | 'incremental' | 'reconcile'

export interface HistoryAuthorizationInput {
  boundary: HistoryBoundary
  entityCapturedAt?: string
  dependencyRequired?: boolean
  phase: ReplicationHistoryPhase
}

export type HistoryAuthorization =
  | { kind: 'full' }
  | { kind: 'minimum-dependency' }
  | { kind: 'blocked'; reason: 'history-boundary' }

function parseTimestamp(value: string | undefined, label: string): number {
  if (!value) throw new Error(`${label} is required for from-now history scope`)
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be an ISO-compatible timestamp`)
  return timestamp
}

export function authorizeHistory(input: HistoryAuthorizationInput): HistoryAuthorization {
  if (input.boundary.mode === 'include-existing') return { kind: 'full' }

  const boundaryAt = parseTimestamp(input.boundary.boundaryCapturedAt, 'boundaryCapturedAt')
  const capturedAt = parseTimestamp(input.entityCapturedAt, 'entityCapturedAt')

  if (capturedAt >= boundaryAt) return { kind: 'full' }
  if (input.dependencyRequired) return { kind: 'minimum-dependency' }
  return { kind: 'blocked', reason: 'history-boundary' }
}

export interface HistoryScopeTransitionDecision {
  relation: 'same' | 'expanded' | 'restricted'
  requireReconcile: boolean
  allowAutomaticHistoricalBackfill: false
  requireExplicitHistoricalAuthorization: boolean
}

export function decideHistoryScopeTransition(
  previous: HistoryBoundary,
  next: HistoryBoundary,
): HistoryScopeTransitionDecision {
  if (previous.mode === next.mode && previous.revision === next.revision) {
    return {
      relation: 'same',
      requireReconcile: false,
      allowAutomaticHistoricalBackfill: false,
      requireExplicitHistoricalAuthorization: false,
    }
  }

  if (previous.mode === 'from-now' && next.mode === 'include-existing') {
    return {
      relation: 'expanded',
      requireReconcile: true,
      allowAutomaticHistoricalBackfill: false,
      requireExplicitHistoricalAuthorization: true,
    }
  }

  if (previous.mode === 'include-existing' && next.mode === 'from-now') {
    return {
      relation: 'restricted',
      requireReconcile: true,
      allowAutomaticHistoricalBackfill: false,
      requireExplicitHistoricalAuthorization: false,
    }
  }

  return {
    relation: 'same',
    requireReconcile: true,
    allowAutomaticHistoricalBackfill: false,
    requireExplicitHistoricalAuthorization: false,
  }
}
