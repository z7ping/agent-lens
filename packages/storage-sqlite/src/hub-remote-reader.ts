import type { JsonValue } from '@agent-lens/core'
import {
  KNOWN_REPLICATION_ENTITY_TYPES,
  type KnownReplicationEntityType,
} from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'

export interface HubRemoteReadSharedIdentity {
  stateKind: 'shared-root' | 'conditional-membership'
  identityAlgorithm: string
  normalizedIdentity?: string
  sharedKey: string
}

export interface HubRemoteReadEntity {
  /** Opaque public id for one remote origin. */
  publicId: string
  originNodeId: string
  generationId: string
  entityType: KnownReplicationEntityType
  originEntityId: string
  scope: 'node' | 'shared'
  entityVersion: number
  contentHash: string
  body: JsonValue
  references?: unknown
  /** Hub-recomputed identity state, never the Node-claimed assertion JSON. */
  sharedIdentity?: HubRemoteReadSharedIdentity
  updatedSequence: number
  updatedAt: string
}

export interface HubRemoteReadQuery {
  originNodeId?: string
  entityType?: KnownReplicationEntityType
  sharedKey?: string
  limit?: number
}

export interface HubRemoteObservationQuery {
  originNodeId: string
  generationId: string
  logicalSessionOriginId: string
  limit?: number
}

type RemoteRowRecord = Record<string, unknown>

function rowRecord(value: unknown): RemoteRowRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Hub remote replica query returned a non-object row')
  }
  return value as RemoteRowRecord
}

function requiredString(row: RemoteRowRecord, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`Hub remote replica field ${key} must be a string`)
  return value
}

function optionalString(row: RemoteRowRecord, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new TypeError(`Hub remote replica field ${key} must be a string or null`)
  return value
}

function requiredNumber(row: RemoteRowRecord, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Hub remote replica field ${key} must be a finite number`)
  }
  return value
}

function parseJsonValue(value: unknown, key: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(item => parseJsonValue(item, key))
  if (typeof value === 'object') {
    const output: { [key: string]: JsonValue } = {}
    for (const [entryKey, entryValue] of Object.entries(value)) output[entryKey] = parseJsonValue(entryValue, key)
    return output
  }
  throw new TypeError(`Hub remote replica field ${key} must contain JSON data`)
}

function parseJsonText(value: unknown, key: string): JsonValue {
  if (typeof value !== 'string') throw new TypeError(`Hub remote replica field ${key} must contain JSON text`)
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new TypeError(`Hub remote replica field ${key} contains invalid JSON`)
  }
  return parseJsonValue(parsed, key)
}

function entityType(row: RemoteRowRecord): KnownReplicationEntityType {
  const value = requiredString(row, 'entityType')
  if (!(KNOWN_REPLICATION_ENTITY_TYPES as readonly string[]).includes(value)) {
    throw new TypeError(`Hub remote replica field entityType has unsupported value: ${value}`)
  }
  return value as KnownReplicationEntityType
}

function scope(row: RemoteRowRecord): 'node' | 'shared' {
  const value = requiredString(row, 'scope')
  if (value !== 'node' && value !== 'shared') {
    throw new TypeError(`Hub remote replica field scope has unsupported value: ${value}`)
  }
  return value
}

function sharedStateKind(row: RemoteRowRecord): HubRemoteReadSharedIdentity['stateKind'] | undefined {
  const value = optionalString(row, 'sharedStateKind')
  if (value === undefined) return undefined
  if (value !== 'shared-root' && value !== 'conditional-membership') {
    throw new TypeError(`Hub remote replica field sharedStateKind has unsupported value: ${value}`)
  }
  return value
}

function mapRow(value: unknown): HubRemoteReadEntity {
  const row = rowRecord(value)
  const stateKind = sharedStateKind(row)
  const sharedIdentityAlgorithm = optionalString(row, 'sharedIdentityAlgorithm')
  const sharedNormalizedIdentity = optionalString(row, 'sharedNormalizedIdentity')
  const sharedKey = optionalString(row, 'sharedKey')
  const referencesJson = optionalString(row, 'referencesJson')
  const sharedIdentity = stateKind && sharedIdentityAlgorithm && sharedKey
    ? {
        stateKind,
        identityAlgorithm: sharedIdentityAlgorithm,
        ...(sharedNormalizedIdentity ? { normalizedIdentity: sharedNormalizedIdentity } : {}),
        sharedKey,
      }
    : undefined

  return {
    publicId: requiredString(row, 'publicId'),
    originNodeId: requiredString(row, 'originNodeId'),
    generationId: requiredString(row, 'generationId'),
    entityType: entityType(row),
    originEntityId: requiredString(row, 'originEntityId'),
    scope: scope(row),
    entityVersion: requiredNumber(row, 'entityVersion'),
    contentHash: requiredString(row, 'contentHash'),
    body: parseJsonText(row.bodyJson, 'bodyJson'),
    ...(referencesJson === undefined ? {} : { references: parseJsonText(referencesJson, 'referencesJson') }),
    ...(sharedIdentity ? { sharedIdentity } : {}),
    updatedSequence: requiredNumber(row, 'updatedSequence'),
    updatedAt: requiredString(row, 'updatedAt'),
  }
}

const ACTIVE_REMOTE_SELECT = `
  SELECT e.replica_key AS publicId,
         e.origin_node_id AS originNodeId,
         e.generation_id AS generationId,
         e.entity_type AS entityType,
         e.origin_entity_id AS originEntityId,
         e.scope,
         e.entity_version AS entityVersion,
         e.content_hash AS contentHash,
         e.body_json AS bodyJson,
         e.references_json AS referencesJson,
         s.state_kind AS sharedStateKind,
         s.identity_algorithm AS sharedIdentityAlgorithm,
         s.normalized_identity AS sharedNormalizedIdentity,
         s.shared_key AS sharedKey,
         e.updated_sequence AS updatedSequence,
         e.updated_at AS updatedAt
  FROM hub_remote_replica_entities e
  JOIN hub_replica_generations g
    ON g.origin_node_id = e.origin_node_id
   AND g.generation_id = e.generation_id
  LEFT JOIN hub_remote_shared_identity_state s
    ON s.origin_node_id = e.origin_node_id
   AND s.generation_id = e.generation_id
   AND s.entity_type = e.entity_type
   AND s.origin_entity_id = e.origin_entity_id
  WHERE g.status = 'active'
`

function boundedLimit(value: number | undefined): number {
  return Math.max(1, Math.min(value ?? 500, 5000))
}

/**
 * Formal read boundary for remote replica state.
 * Consumers never query Hub replica private tables or perform generation filtering themselves.
 * Staged/retired generations are intentionally invisible here.
 */
export class SqliteHubRemoteReadRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async get(publicId: string): Promise<HubRemoteReadEntity | undefined> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`${ACTIVE_REMOTE_SELECT}
        AND e.replica_key = ?
        LIMIT 1
      `).get(publicId)
      return row ? mapRow(row) : undefined
    })
  }

  async list(query: HubRemoteReadQuery = {}): Promise<readonly HubRemoteReadEntity[]> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (query.originNodeId) {
      conditions.push('e.origin_node_id = ?')
      params.push(query.originNodeId)
    }
    if (query.entityType) {
      conditions.push('e.entity_type = ?')
      params.push(query.entityType)
    }
    if (query.sharedKey) {
      conditions.push('s.shared_key = ?')
      params.push(query.sharedKey)
    }
    const extraWhere = conditions.length ? ` AND ${conditions.join(' AND ')}` : ''

    return this.executor.run(() => this.executor.db.prepare(`${ACTIVE_REMOTE_SELECT}
      ${extraWhere}
      ORDER BY e.origin_node_id, e.entity_type, e.replica_key
      LIMIT ?
    `).all(...params, boundedLimit(query.limit)).map(mapRow))
  }

  /** Active-generation LogicalSessions ordered by real replicated session time. */
  async listLogicalSessions(limit?: number): Promise<readonly HubRemoteReadEntity[]> {
    return this.executor.run(() => this.executor.db.prepare(`${ACTIVE_REMOTE_SELECT}
      AND e.entity_type = 'LogicalSession'
      ORDER BY
        CASE
          WHEN json_extract(e.body_json, '$.endedAt.state') = 'value'
            THEN json_extract(e.body_json, '$.endedAt.value')
          WHEN json_extract(e.body_json, '$.startedAt.state') = 'value'
            THEN json_extract(e.body_json, '$.startedAt.value')
          ELSE NULL
        END DESC,
        e.origin_node_id ASC,
        e.replica_key ASC
      LIMIT ?
    `).all(boundedLimit(limit)).map(mapRow))
  }

  /**
   * Resolve the typed LogicalSession node reference inside one active remote
   * generation's CanonicalObservation envelopes. The private JSON storage
   * detail stays below this repository boundary.
   */
  async listCanonicalObservationsForLogicalSession(
    query: HubRemoteObservationQuery,
  ): Promise<readonly HubRemoteReadEntity[]> {
    return this.executor.run(() => this.executor.db.prepare(`${ACTIVE_REMOTE_SELECT}
      AND e.origin_node_id = ?
      AND e.generation_id = ?
      AND e.entity_type = 'CanonicalObservation'
      AND json_extract(e.references_json, '$.logicalSession.kind') = 'node'
      AND json_extract(e.references_json, '$.logicalSession.entityType') = 'LogicalSession'
      AND json_extract(e.references_json, '$.logicalSession.originEntityId') = ?
      ORDER BY
        COALESCE(
          json_extract(e.body_json, '$.occurredAt.value'),
          json_extract(e.body_json, '$.capturedAt.value'),
          e.updated_at
        ),
        COALESCE(
          json_extract(e.body_json, '$.canonicalSequence.value'),
          json_extract(e.body_json, '$.sourceSequence.value'),
          9007199254740991
        ),
        e.replica_key
      LIMIT ?
    `).all(
      query.originNodeId,
      query.generationId,
      query.logicalSessionOriginId,
      boundedLimit(query.limit),
    ).map(mapRow))
  }
}
