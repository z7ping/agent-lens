import type { JsonValue } from '../domain/common'
import type { KnownReplicationEntityType } from './types'
import { authorizeHistory, type ReplicationHistoryPhase } from './history'
import {
  applyReplicationFieldPolicy,
  getReplicationEntityContract,
  type HistoryBoundary,
  type ReplicationAvailability,
  type ReplicationFieldClass,
  type ReplicationPolicy,
} from './policy'

export interface ReplicationEntityTransformInput {
  entityType: KnownReplicationEntityType
  body: Readonly<Record<string, JsonValue | undefined>>
  capturedAt?: string
  dependencyRequired?: boolean
  phase: ReplicationHistoryPhase
  policy: ReplicationPolicy
  history: HistoryBoundary
  captureStates?: Readonly<Record<string, 'available' | 'not-captured' | 'redacted'>>
}

export interface ReplicationEntityTransformResult {
  entityType: KnownReplicationEntityType
  body: Readonly<Record<string, ReplicationAvailability>>
  historyAuthorization: 'full' | 'minimum-dependency' | 'blocked'
}

export function transformReplicationEntity(input: ReplicationEntityTransformInput): ReplicationEntityTransformResult {
  const history = authorizeHistory({
    boundary: input.history,
    entityCapturedAt: input.capturedAt,
    dependencyRequired: input.dependencyRequired,
    phase: input.phase,
  })
  const contract = getReplicationEntityContract(input.entityType)
  const fieldContracts = new Map(contract.fields.map(field => [field.field, field]))
  const body: Record<string, ReplicationAvailability> = {}

  for (const [field, value] of Object.entries(input.body)) {
    const contractField = fieldContracts.get(field)
    const fieldClass: ReplicationFieldClass = contractField?.class ?? 'metadata'
    let historyState: 'allowed' | 'history-boundary' | 'dependency-minimized' = 'allowed'

    if (history.kind === 'blocked') historyState = 'history-boundary'
    if (history.kind === 'minimum-dependency' && !contractField?.minimumDependency) {
      historyState = 'dependency-minimized'
    }

    body[field] = applyReplicationFieldPolicy({
      value,
      fieldClass,
      policy: input.policy,
      captureState: input.captureStates?.[field] ?? 'available',
      historyState,
    })
  }

  return {
    entityType: input.entityType,
    body,
    historyAuthorization: history.kind === 'blocked' ? 'blocked' : history.kind,
  }
}
