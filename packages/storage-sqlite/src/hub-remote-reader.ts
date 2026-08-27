import type { JsonValue } from '@agent-lens/core'
import type { KnownReplicationEntityType } from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'

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
  sharedIdentity?: unknown
  updatedSequence: number
  updatedAt: string
}

export interface HubRemoteReadQuery {
  originNodeId?: string
  entityType?: KnownReplicationEntityType
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
  sharedIdentityJson: string | null
  updatedSequence: number
  updatedAt: string
}

function mapRow(row: RemoteRow): HubRemoteReadEntity {
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
    ...(row.sharedIdentityJson ? { sharedIdentity: JSON.parse(row.sharedIdentityJson) } : {}),
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
         e.shared_identity_json AS sharedIdentityJson,
         e.updated_sequence AS updatedSequence,
         e.updated_at AS updatedAt
  FROM hub_remote_replica_entities e
  JOIN hub_replica_generations g
    ON g.origin_node_id = e.origin_node_id
   AND g.generation_id = e.generation_id
  WHERE g.status = 'active'
`

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
    const extraWhere = conditions.length ? ` AND ${conditions.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(query.limit ?? 500, 5000))

    return this.executor.run(() => {
      const rows = this.executor.db.prepare(`${ACTIVE_REMOTE_SELECT}
        ${extraWhere}
        ORDER BY e.origin_node_id, e.entity_type, e.replica_key
        LIMIT ?
      `).all(...params, limit) as RemoteRow[]
      return rows.map(mapRow)
    })
  }
}
