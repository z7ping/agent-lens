import type { JsonValue } from '@agent-lens/core'
import type { KnownReplicationEntityType } from '@agent-lens/core/replication'
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
  logicalSessionOriginId: string
  limit?: number
}

interface RemoteRow {
  publicId: string
  originNodeId: string
  generationId: string
  entityType: KnownReplicationEntityType
  originEntityId: string
  scope: 'node' | 'shared'
  entityVersion: number
  contentHash: string
  bodyJson: string
  referencesJson: string | null
  sharedStateKind: 'shared-root' | 'conditional-membership' | null
  sharedIdentityAlgorithm: string | null
  sharedNormalizedIdentity: string | null
  sharedKey: string | null
  updatedSequence: number
  updatedAt: string
}

function mapRow(row: RemoteRow): HubRemoteReadEntity {
  const sharedIdentity = row.sharedStateKind && row.sharedIdentityAlgorithm && row.sharedKey
    ? {
        stateKind: row.sharedStateKind,
        identityAlgorithm: row.sharedIdentityAlgorithm,
        ...(row.sharedNormalizedIdentity ? { normalizedIdentity: row.sharedNormalizedIdentity } : {}),
        sharedKey: row.sharedKey,
      }
    : undefined

  return {
    publicId: row.publicId,
    originNodeId: row.originNodeId,
    generationId: row.generationId,
    entityType: row.entityType,
    originEntityId: row.originEntityId,
    scope: row.scope,
    entityVersion: Number(row.entityVersion),
    contentHash: row.contentHash,
    body: JSON.parse(row.bodyJson) as JsonValue,
    ...(row.referencesJson ? { references: JSON.parse(row.referencesJson) } : {}),
    ...(sharedIdentity ? { sharedIdentity } : {}),
    updatedSequence: Number(row.updatedSequence),
    updatedAt: row.updatedAt,
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
      `).get(publicId) as RemoteRow | undefined
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

    return this.executor.run(() => {
      const rows = this.executor.db.prepare(`${ACTIVE_REMOTE_SELECT}
        ${extraWhere}
        ORDER BY e.origin_node_id, e.entity_type, e.replica_key
        LIMIT ?
      `).all(...params, boundedLimit(query.limit)) as RemoteRow[]
      return rows.map(mapRow)
    })
  }

  /**
   * Resolve the typed LogicalSession node reference inside active remote
   * CanonicalObservation envelopes. The private JSON storage detail stays
   * below this repository boundary; projections never inspect references_json.
   */
  async listCanonicalObservationsForLogicalSession(
    query: HubRemoteObservationQuery,
  ): Promise<readonly HubRemoteReadEntity[]> {
    return this.executor.run(() => {
      const rows = this.executor.db.prepare(`${ACTIVE_REMOTE_SELECT}
        AND e.origin_node_id = ?
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
        query.logicalSessionOriginId,
        boundedLimit(query.limit),
      ) as RemoteRow[]
      return rows.map(mapRow)
    })
  }
}
