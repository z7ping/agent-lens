import type { JsonValue } from '../domain/common'
import { isReplicatedEntityType } from './scope'
import type { KnownReplicationEntityType } from './types'
import { authorizeHistory, type HistoryAuthorizationInput, type ReplicationHistoryPhase } from './history'
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

export class ReplicationPolicyError extends Error {
  readonly code: 'ENTITY_NOT_REPLICATED' | 'ENTITY_CONTRACT_MISSING'

  constructor(code: 'ENTITY_NOT_REPLICATED' | 'ENTITY_CONTRACT_MISSING', message: string) {
    super(message)
    this.name = 'ReplicationPolicyError'
    this.code = code
  }
}

export function transformReplicationEntity(input: ReplicationEntityTransformInput): ReplicationEntityTransformResult {
  if (!isReplicatedEntityType(input.entityType)) {
    throw new ReplicationPolicyError(
      'ENTITY_NOT_REPLICATED',
      `${input.entityType} is not part of the replication entity set`,
    )
  }

  const contract = getReplicationEntityContract(input.entityType)
  if (!contract) {
    throw new ReplicationPolicyError(
      'ENTITY_CONTRACT_MISSING',
      `Replication field contract is missing for ${input.entityType}`,
    )
  }

  const historyInput: HistoryAuthorizationInput = {
    boundary: input.history,
    phase: input.phase,
  }
  if (input.capturedAt !== undefined) historyInput.entityCapturedAt = input.capturedAt
  if (input.dependencyRequired !== undefined) historyInput.dependencyRequired = input.dependencyRequired

  const history = authorizeHistory(historyInput)
  const fieldContracts = new Map(contract.fields.map(field => [field.field, field]))
  const body: Record<string, ReplicationAvailability> = {}

  for (const [field, value] of Object.entries(input.body)) {
    const contractField = fieldContracts.get(field)
    const fieldClass: ReplicationFieldClass = contractField?.class ?? 'unclassified'
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
