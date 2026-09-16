import type {
  IndependentReplicationRootEntityType,
  IndependentReplicationRootSnapshot,
  IndependentReplicationRootSnapshotPage,
  IndependentReplicationRootSnapshotSource,
} from '@agent-lens/core/replication'
import type { SqliteExecutor } from './executor'
import {
  mapActor,
  mapAssetBinding,
  mapAssetDefinition,
  mapAssetStateObservation,
  mapCoverage,
  mapEvidence,
  mapHost,
  mapInstallation,
  mapLogicalSession,
  mapProduct,
  mapProject,
  mapRelationship,
  mapRuntimeProfile,
  mapSourceRecord,
  mapSourceSession,
  mapTool,
  mapWorkspace,
} from './repository-row-mappers'

type RootConfig = {
  table: string
  map(value: unknown): IndependentReplicationRootSnapshot['entity']
}

const ROOTS: Readonly<Record<IndependentReplicationRootEntityType, RootConfig>> = {
  AgentProduct: { table: 'agent_products', map: mapProduct },
  Host: { table: 'hosts', map: mapHost },
  AgentInstallation: { table: 'agent_installations', map: mapInstallation },
  RuntimeProfile: { table: 'runtime_profiles', map: mapRuntimeProfile },
  Project: { table: 'projects', map: mapProject },
  Workspace: { table: 'workspaces', map: mapWorkspace },
  LogicalSession: { table: 'logical_sessions', map: mapLogicalSession },
  SourceSession: { table: 'source_sessions', map: mapSourceSession },
  SessionRelationship: { table: 'session_relationships', map: mapRelationship },
  AgentActor: { table: 'agent_actors', map: mapActor },
  SourceRecord: { table: 'source_records', map: mapSourceRecord },
  Evidence: { table: 'evidence', map: mapEvidence },
  Coverage: { table: 'coverage', map: mapCoverage },
  AssetDefinition: { table: 'asset_definitions', map: mapAssetDefinition },
  AssetBinding: { table: 'asset_bindings', map: mapAssetBinding },
  AssetStateObservation: { table: 'asset_state_observations', map: mapAssetStateObservation },
  ToolDefinition: { table: 'tool_definitions', map: mapTool },
}

type Row = Record<string, unknown>

function rowRecord(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Independent replication Root row must be an object')
  }
  return value as Row
}

function requiredString(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') {
    throw new TypeError(`Independent replication Root field ${key} must be a string`)
  }
  return value
}

function requiredRevision(row: Row, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`Independent replication Root field ${key} must be a non-negative integer`)
  }
  return value
}

function rootTable(entityType: IndependentReplicationRootEntityType): RootConfig {
  return ROOTS[entityType]
}

function normalizedBoundary(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) {
    throw new TypeError('Independent replication Root changedAtOnOrAfter must be an ISO-compatible timestamp')
  }
  return new Date(timestamp).toISOString()
}

function mapSnapshot(
  entityType: IndependentReplicationRootEntityType,
  value: unknown,
): IndependentReplicationRootSnapshot {
  const row = rowRecord(value)
  const originEntityId = requiredString(row, '__origin_entity_id')
  const entity = rootTable(entityType).map(value)
  if (!entity || typeof entity !== 'object' || !('id' in entity) || entity.id !== originEntityId) {
    throw new Error(`Independent replication Root identity mismatch: ${entityType}:${originEntityId}`)
  }
  return {
    entityType,
    originEntityId,
    latestRevision: requiredRevision(row, '__latest_revision'),
    changedAt: requiredString(row, '__latest_changed_at'),
    entity,
  } as IndependentReplicationRootSnapshot
}

/**
 * Current-state reader for R1 entities that are not reconstructed through the
 * CanonicalObservation Root Graph. Entity Head only provides bounded revision /
 * changedAt metadata; the entity body is always read from the Canonical table.
 */
export class SqliteReplicationIndependentRootSnapshotReader
implements IndependentReplicationRootSnapshotSource {
  constructor(private readonly executor: SqliteExecutor) {}

  async scan(input: {
    entityType: IndependentReplicationRootEntityType
    afterId?: string
    changedAtOnOrAfter?: string
    limit?: number
  }): Promise<IndependentReplicationRootSnapshotPage> {
    const config = rootTable(input.entityType)
    const limit = Math.max(1, Math.min(input.limit ?? 100, 5000))
    const afterId = input.afterId ?? ''
    const changedAtOnOrAfter = normalizedBoundary(input.changedAtOnOrAfter)
    return this.executor.run(() => {
      const params: unknown[] = [input.entityType, afterId]
      const boundary = changedAtOnOrAfter === undefined
        ? ''
        : 'AND h.latest_changed_at >= ?'
      if (changedAtOnOrAfter !== undefined) params.push(changedAtOnOrAfter)
      params.push(limit)

      const rows = this.executor.db.prepare(`
        SELECT t.*,
               h.origin_entity_id AS __origin_entity_id,
               h.latest_revision AS __latest_revision,
               h.latest_changed_at AS __latest_changed_at
        FROM replication_entity_heads h
        JOIN ${config.table} t ON t.id = h.origin_entity_id
        WHERE h.entity_type = ?
          AND h.origin_entity_id > ?
          ${boundary}
        ORDER BY h.origin_entity_id
        LIMIT ?
      `).all(...params)

      const items = rows.map(value => mapSnapshot(input.entityType, value))
      return {
        items,
        ...(items.length === 0
          ? (input.afterId === undefined ? {} : { nextCursor: input.afterId })
          : { nextCursor: items.at(-1)!.originEntityId }),
        done: items.length < limit,
      }
    })
  }

  async get(
    entityType: IndependentReplicationRootEntityType,
    originEntityId: string,
  ): Promise<IndependentReplicationRootSnapshot | null> {
    const config = rootTable(entityType)
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT t.*,
               h.origin_entity_id AS __origin_entity_id,
               h.latest_revision AS __latest_revision,
               h.latest_changed_at AS __latest_changed_at
        FROM replication_entity_heads h
        JOIN ${config.table} t ON t.id = h.origin_entity_id
        WHERE h.entity_type = ?
          AND h.origin_entity_id = ?
      `).get(entityType, originEntityId)
      return row ? mapSnapshot(entityType, row) : null
    })
  }
}
