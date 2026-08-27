export const REPLICATION_PROTOCOL = Object.freeze({ major: 1, minor: 0 })
export const REPLICA_KEY_ALGORITHM = 'agentlens-replica-r1' as const
export const PROJECT_IDENTITY_ALGORITHM = 'project-repository-v1' as const
export const ASSET_IDENTITY_ALGORITHM = 'asset-upstream-v1' as const

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface ProtocolVersion {
  major: number
  minor: number
}

export interface EntityVersionSupport {
  entityType: string
  versions: readonly number[]
}

export interface ReplicationHandshakeRequest {
  nodeId: string
  hubId: string
  streamId: string
  agentLensVersion: string
  protocol: ProtocolVersion
  capabilities: readonly string[]
  identityAlgorithms: readonly string[]
  entityVersions: readonly EntityVersionSupport[]
  policyRevision: string
  historyRevision: string
  clientNonce: string
}

export interface ReplicationHandshakeResponse {
  hubId: string
  nodeId: string
  streamId: string
  selectedProtocol: ProtocolVersion
  selectedIdentityAlgorithms: readonly string[]
  selectedEntityVersions: readonly EntityVersionSupport[]
  ackSequence: number
  serverProof: string
  serverTime: string
}

export interface NodeEntityRef {
  kind: 'node'
  entityType: string
  originEntityId: string
}

export interface SharedEntityRef {
  kind: 'shared'
  entityType: 'AgentProduct'
  sharedKey: string
}

export type WireEntityRef = NodeEntityRef | SharedEntityRef

export type Availability<T extends JsonValue = JsonValue> =
  | { state: 'value'; value: T }
  | { state: 'null' }
  | { state: 'redacted' }
  | { state: 'omitted'; reason: 'policy' | 'not-captured' | 'history-boundary' | 'dependency-minimized' }

export interface SharedIdentityAssertion {
  identityAlgorithm: typeof PROJECT_IDENTITY_ALGORITHM | typeof ASSET_IDENTITY_ALGORITHM | string
  normalizedPortableIdentity: string
  claimedSharedKey: string
}

export interface WireEntityEnvelope {
  entityType: string
  scope: 'node' | 'shared'
  originEntityId: string
  entityVersion: number
  body: JsonValue
  references?: Readonly<Record<string, WireEntityRef | readonly WireEntityRef[]>>
  replicaKey?: string
  sharedIdentity?: SharedIdentityAssertion
  contentHash: string
}

export interface ReplicationBatch {
  protocol: ProtocolVersion
  nodeId: string
  hubId: string
  streamId: string
  generationId: string
  sequence: number
  batchId: string
  phase: 'bootstrap' | 'incremental' | 'reconcile'
  policyRevision: string
  historyRevision: string
  entities: readonly WireEntityEnvelope[]
  identityPromotions: readonly SharedIdentityAssertion[]
  tombstones?: readonly WireTombstone[]
  contentHash: string
}

export interface WireTombstone {
  entityType: string
  originEntityId: string
  deletedAt: string
  contentHash: string
}

export type ReplicationErrorCode =
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  | 'IDENTITY_ALGORITHM_UNSUPPORTED'
  | 'SHARED_IDENTITY_MISMATCH'
  | 'ENTITY_TYPE_UNSUPPORTED'
  | 'ENTITY_VERSION_UNSUPPORTED'
  | 'ENTITY_SCOPE_INVALID'
  | 'ENTITY_REFERENCE_INVALID'
  | 'ENTITY_HASH_MISMATCH'
  | 'BATCH_HASH_MISMATCH'
  | 'BATCH_INVALID'
  | 'SEQUENCE_REUSE_CONFLICT'
  | 'SEQUENCE_GAP'

export class ReplicationProtocolError extends Error {
  readonly code: ReplicationErrorCode

  constructor(code: ReplicationErrorCode, message: string) {
    super(message)
    this.name = 'ReplicationProtocolError'
    this.code = code
  }
}

export interface SequenceDecision {
  action: 'process' | 'retry-ack' | 'reject'
  errorCode?: 'SEQUENCE_REUSE_CONFLICT' | 'SEQUENCE_GAP'
}
