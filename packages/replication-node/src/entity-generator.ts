import type { JsonValue as CoreJsonValue } from '@agent-lens/core'
import {
  createOriginEntityRef,
  replicaKeyFor,
  replicationEntityScope,
  sharedRootKeyFor,
  transformReplicationEntity,
  type HistoryBoundary,
  type KnownReplicationEntityType,
  type ReplicationHistoryPhase,
  type ReplicationPolicy,
} from '@agent-lens/core/replication'
import {
  assertEntityEnvelope,
  computeEntityContentHash,
  type JsonValue,
  type SharedEntityRef,
  type SharedIdentityAssertion,
  type WireEntityEnvelope,
  type WireEntityRef,
} from '@agent-lens/protocol/replication'

export interface GenerateWireEntityInput {
  nodeId: string
  entityType: KnownReplicationEntityType
  originEntityId: string
  body: Readonly<Record<string, CoreJsonValue | undefined>>
  references?: Readonly<Record<string, WireEntityRef | readonly WireEntityRef[]>> | undefined
  capturedAt?: string | undefined
  dependencyRequired?: boolean | undefined
  phase: ReplicationHistoryPhase
  policy: ReplicationPolicy
  history: HistoryBoundary
  captureStates?: Readonly<Record<string, 'available' | 'not-captured' | 'redacted'>> | undefined
  sharedIdentity?: SharedIdentityAssertion | undefined
}

export type GenerateWireEntityResult =
  | { kind: 'entity'; entity: WireEntityEnvelope }
  | { kind: 'blocked'; reason: 'history-boundary' }

/**
 * Cross-layer composition point for H2 identity + H4 outbound policy + H3 wire.
 * It never reads SQLite and never mutates Canonical state.
 */
export function generateWireEntity(input: GenerateWireEntityInput): GenerateWireEntityResult {
  const transformed = transformReplicationEntity({
    entityType: input.entityType,
    body: input.body,
    phase: input.phase,
    policy: input.policy,
    history: input.history,
    ...(input.capturedAt === undefined ? {} : { capturedAt: input.capturedAt }),
    ...(input.dependencyRequired === undefined ? {} : { dependencyRequired: input.dependencyRequired }),
    ...(input.captureStates === undefined ? {} : { captureStates: input.captureStates }),
  })

  if (transformed.historyAuthorization === 'blocked') {
    return { kind: 'blocked', reason: 'history-boundary' }
  }

  const scope = replicationEntityScope(input.entityType)
  if (scope === 'not-replicated') {
    // transformReplicationEntity already rejects this; keep this guard explicit at the wire boundary.
    throw new Error(`${input.entityType} is not a replicated wire entity`)
  }

  const wireScope = input.entityType === 'AgentProduct' ? 'shared' as const : 'node' as const
  const origin = createOriginEntityRef(input.nodeId, input.entityType, input.originEntityId)
  const body = transformed.body as unknown as JsonValue
  const base: Omit<WireEntityEnvelope, 'contentHash'> = {
    entityType: input.entityType,
    scope: wireScope,
    originEntityId: input.originEntityId,
    entityVersion: 1,
    body,
    ...(input.references === undefined ? {} : { references: input.references }),
    ...(wireScope === 'node' ? { replicaKey: replicaKeyFor(origin) } : {}),
    ...(input.sharedIdentity === undefined ? {} : { sharedIdentity: input.sharedIdentity }),
  }
  const entity: WireEntityEnvelope = {
    ...base,
    contentHash: computeEntityContentHash(base),
  }
  assertEntityEnvelope(entity)
  return { kind: 'entity', entity }
}

export function nodeEntityRef(entityType: string, originEntityId: string): WireEntityRef {
  return { kind: 'node', entityType, originEntityId }
}

export function agentProductSharedRef(productId: string): SharedEntityRef {
  return {
    kind: 'shared',
    entityType: 'AgentProduct',
    sharedKey: sharedRootKeyFor('AgentProduct', productId),
  }
}
