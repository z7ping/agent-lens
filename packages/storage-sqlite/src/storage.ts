import { existsSync, statSync } from 'node:fs'
import Database from 'better-sqlite3'
import type {
  CheckpointRepository,
  RepositorySet,
  StorageHealth,
  StorageService,
  StorageTransaction,
} from '@agent-lens/core'
import { SqliteAssetInventoryReader } from './asset-inventory'
import { SqliteCheckpointRepository } from './checkpoints'
import { SqliteExecutor } from './executor'
import { SqliteFacetScopeReader } from './facet-scope'
import { SqliteLaunchableProjectReader } from './launchable-projects'
import { SqliteStorageMaintenance } from './maintenance'
import { SqliteMaintenanceJobStore } from './maintenance-jobs'
import { migrateDatabase } from './migrations'
import { withSqliteObservationPagination } from './observation-pagination'
import { withSqliteParserReplayReplacement } from './parser-replay-replacement'
import { SqliteProjectionBackfillMaintenance } from './projection-backfill'
import { createSqliteRepositories } from './repositories'
import { SqliteReplicationCanonicalChangeReader } from './replication-canonical-changes'
import { SqliteReplicationStateRepository } from './replication-state'
import { SqliteSessionRelationshipCandidateRepository } from './relationship-candidates'
import { SqliteRuntimeProfileRepository } from './runtime-profiles'
import { SqliteSourceRuntimeStatusRepository } from './runtime-status'
import { withSqliteSessionRuntimeProfiles } from './session-runtime-profile'
import { SqliteSessionSummaryReader } from './session-summaries-v2'
import { withSqliteSourceRecordCompression } from './source-record-compression'
import { SqliteToolUsageObservationReader } from './tool-usage-observations-v2'
import { SqliteUnknownObservationProjection } from './unknown-observation-projection'

const STORAGE_SOFT_LIMIT_BYTES = 512 * 1024 * 1024
const STORAGE_APPROACHING_RATIO = 0.8
const COVERAGE_STATUSES = ['complete', 'partial', 'unavailable', 'unknown'] as const

type StorageRow = Record<string, unknown>

function rowRecord(value: unknown): StorageRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite storage diagnostic query returned a non-object row')
  }
  return value as StorageRow
}

function requiredNumber(row: StorageRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`SQLite storage diagnostic field ${key} must be a finite number`)
  }
  return value
}

function optionalString(row: StorageRow, key: string): string | null {
  const value = row[key]
  if (value == null) return null
  if (typeof value !== 'string') {
    throw new TypeError(`SQLite storage diagnostic field ${key} must be a string or null`)
  }
  return value
}

function countRow(value: unknown): number {
  return requiredNumber(rowRecord(value), 'count')
}

function versionRow(value: unknown): number {
  return requiredNumber(rowRecord(value), 'version')
}

function probeOk(value: unknown): boolean {
  return requiredNumber(rowRecord(value), 'ok') === 1
}

function runtimeStatusRow(value: unknown): StorageRow {
  const row = rowRecord(value)
  if (typeof row.state !== 'string') {
    throw new TypeError('SQLite source runtime diagnostic field state must be a string')
  }
  return row
}

function checkpointSummaryRow(value: unknown): { count: number; lastUpdatedAt: string | null } {
  const row = rowRecord(value)
  return {
    count: requiredNumber(row, 'count'),
    lastUpdatedAt: optionalString(row, 'lastUpdatedAt'),
  }
}

function coverageStatus(value: unknown): typeof COVERAGE_STATUSES[number] | undefined {
  const row = rowRecord(value)
  const status = row.status
  return typeof status === 'string' && (COVERAGE_STATUSES as readonly string[]).includes(status)
    ? status as typeof COVERAGE_STATUSES[number]
    : undefined
}

function readonlyRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}


type StorageCategoryName =
  | 'canonical'
  | 'evidence'
  | 'sourceRaw'
  | 'projection'
  | 'replication'
  | 'operational'

const CANONICAL_TABLES = new Set([
  'hosts',
  'agent_products',
  'agent_installations',
  'runtime_profiles',
  'projects',
  'workspaces',
  'logical_sessions',
  'source_sessions',
  'session_relationships',
  'agent_actors',
  'interactions',
  'observations',
  'asset_definitions',
  'asset_bindings',
  'asset_state_observations',
  'tool_definitions',
])
const EVIDENCE_TABLES = new Set(['evidence', 'observation_evidence', 'coverage'])
const PROJECTION_TABLES = new Set([
  'session_summary_projection',
  'unknown_observation_projection',
  'tool_usage_fact_projection',
])

function storageCategoryForTable(tableName: string): StorageCategoryName {
  if (tableName === 'source_records') return 'sourceRaw'
  if (CANONICAL_TABLES.has(tableName)) return 'canonical'
  if (EVIDENCE_TABLES.has(tableName)) return 'evidence'
  if (PROJECTION_TABLES.has(tableName)) return 'projection'
  if (tableName.startsWith('replication_') || tableName.startsWith('hub_')) return 'replication'
  return 'operational'
}

function ratioOrNull(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

export function describeStorageCapacity(footprintBytes: number, softLimitBytes = STORAGE_SOFT_LIMIT_BYTES) {
  const ratio = softLimitBytes > 0 ? footprintBytes / softLimitBytes : 0
  return {
    softLimitBytes,
    footprintBytes,
    ratio,
    state: ratio >= 1 ? 'exceeded' : ratio >= STORAGE_APPROACHING_RATIO ? 'approaching' : 'healthy',
  } as const
}

export interface SqliteStorageOptions {
  path: string
  readonly?: boolean
}

function fileSize(path: string): number {
  if (!path || path === ':memory:' || !existsSync(path)) return 0
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export class SqliteStorageService implements StorageService {
  readonly db: Database.Database
  readonly repositories: RepositorySet
  readonly checkpoints: CheckpointRepository
  readonly assetInventory: SqliteAssetInventoryReader
  readonly facetScope: SqliteFacetScopeReader
  readonly sessionSummaries: SqliteSessionSummaryReader
  readonly sessionSummaryProjection: SqliteSessionSummaryReader
  readonly launchableProjects: SqliteLaunchableProjectReader
  readonly toolUsageObservations: SqliteToolUsageObservationReader
  readonly unknownObservationProjection: SqliteUnknownObservationProjection
  readonly maintenance: SqliteStorageMaintenance
  readonly maintenanceJobs: SqliteMaintenanceJobStore
  readonly projectionBackfill: SqliteProjectionBackfillMaintenance
  readonly runtimeProfiles: SqliteRuntimeProfileRepository
  readonly sourceRuntimeStatus: SqliteSourceRuntimeStatusRepository
  readonly sessionRelationshipCandidates: SqliteSessionRelationshipCandidateRepository
  readonly replication: SqliteReplicationStateRepository
  readonly replicationCanonicalChanges: SqliteReplicationCanonicalChangeReader
  readonly executor: SqliteExecutor

  constructor(options: SqliteStorageOptions) {
    this.db = new Database(options.path, {
      readonly: options.readonly ?? false,
      fileMustExist: options.readonly ?? false,
    })
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    if (!this.db.memory && !this.db.readonly) {
      this.db.pragma('journal_mode = WAL')
    }

    this.executor = new SqliteExecutor(this.db)
    const baseRepositories = createSqliteRepositories(this.executor)
    const compressedSourceRecords = withSqliteSourceRecordCompression(
      this.executor,
      baseRepositories.sourceRecords,
    )
    const replayAware = withSqliteParserReplayReplacement(
      this.executor,
      compressedSourceRecords,
      baseRepositories.observations,
    )
    this.repositories = {
      ...baseRepositories,
      sourceRecords: replayAware.sourceRecords,
      sessions: withSqliteSessionRuntimeProfiles(this.executor, baseRepositories.sessions),
      observations: withSqliteObservationPagination(this.executor, replayAware.observations),
    }
    this.checkpoints = new SqliteCheckpointRepository(this.executor)
    this.assetInventory = new SqliteAssetInventoryReader(this.executor)
    this.facetScope = new SqliteFacetScopeReader(this.executor)
    const sessionSummaries = new SqliteSessionSummaryReader(this.executor)
    this.sessionSummaries = sessionSummaries
    this.sessionSummaryProjection = sessionSummaries
    this.launchableProjects = new SqliteLaunchableProjectReader(this.executor)
    this.toolUsageObservations = new SqliteToolUsageObservationReader(this.executor)
    this.unknownObservationProjection = new SqliteUnknownObservationProjection(this.executor)
    this.maintenance = new SqliteStorageMaintenance(this.executor)
    this.maintenanceJobs = new SqliteMaintenanceJobStore(this.executor)
    this.projectionBackfill = new SqliteProjectionBackfillMaintenance(this.executor)
    this.runtimeProfiles = new SqliteRuntimeProfileRepository(this.executor)
    this.sourceRuntimeStatus = new SqliteSourceRuntimeStatusRepository(this.executor)
    this.sessionRelationshipCandidates = new SqliteSessionRelationshipCandidateRepository(this.executor)
    this.replication = new SqliteReplicationStateRepository(this.executor)
    this.replicationCanonicalChanges = new SqliteReplicationCanonicalChangeReader(this.executor)
  }

  async transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    return this.executor.transaction(() => fn(this.repositories))
  }

  async migrate(): Promise<void> {
    if (this.db.readonly) {
      throw new Error('Cannot migrate a read-only AgentLens SQLite database')
    }
    await this.executor.run(() => migrateDatabase(this.db))
  }

  private schemaVersion(): number {
    const migrationTable = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
    `).get()
    return migrationTable
      ? versionRow(this.db.prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
      ).get())
      : 0
  }

  private runtimeHealthDetails() {
    const runtimeStatusTable = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_runtime_status'
    `).get()
    const items = runtimeStatusTable
      ? this.db.prepare(`
          SELECT source_id AS sourceId,
                 installation_id AS installationId,
                 runtime_profile_id AS runtimeProfileId,
                 stage,
                 state,
                 last_success_at AS lastSuccessAt,
                 last_error_at AS lastErrorAt,
                 error_count AS errorCount,
                 last_error_summary AS lastErrorSummary
          FROM source_runtime_status
          ORDER BY source_id, installation_id, runtime_profile_id, stage
        `).all().map(runtimeStatusRow)
      : []
    return {
      failed: items.filter(item => item.state === 'failed').length,
      running: items.filter(item => item.state === 'running').length,
      items,
    }
  }

  private capacityDetails() {
    const pageCount = Number(this.db.pragma('page_count', { simple: true }))
    const pageSize = Number(this.db.pragma('page_size', { simple: true }))
    const freelistCount = Number(this.db.pragma('freelist_count', { simple: true }))
    const databaseBytes = fileSize(this.db.name)
    const walBytes = fileSize(`${this.db.name}-wal`)
    const shmBytes = fileSize(`${this.db.name}-shm`)
    const logicalBytes = pageCount * pageSize
    const reclaimableBytes = freelistCount * pageSize
    let tempAllocatedBytes = 0
    try {
      const tempPageCount = Number(this.db.pragma('temp.page_count', { simple: true }))
      const tempPageSize = Number(this.db.pragma('temp.page_size', { simple: true }))
      tempAllocatedBytes = tempPageCount * tempPageSize
    } catch {
      // TEMP storage can be unavailable before SQLite creates the temp schema.
    }
    const hotFootprintBytes = Math.max(databaseBytes, logicalBytes) + walBytes
    return {
      databaseBytes,
      walBytes,
      shmBytes,
      tempAllocatedBytes,
      logicalBytes,
      databaseAllocatedBytes: logicalBytes,
      reclaimableBytes,
      totalDiskBytes: databaseBytes + walBytes + shmBytes,
      hotFootprintBytes,
      capacity: {
        ...describeStorageCapacity(hotFootprintBytes),
        scope: 'hot-sqlite',
        longTermTotalLimitBytes: null,
      },
    }
  }

  private storageBreakdownDetails() {
    const categories: Record<StorageCategoryName, {
      payloadBytes: number
      allocatedBytes: number
      tables: number
    }> = {
      canonical: { payloadBytes: 0, allocatedBytes: 0, tables: 0 },
      evidence: { payloadBytes: 0, allocatedBytes: 0, tables: 0 },
      sourceRaw: { payloadBytes: 0, allocatedBytes: 0, tables: 0 },
      projection: { payloadBytes: 0, allocatedBytes: 0, tables: 0 },
      replication: { payloadBytes: 0, allocatedBytes: 0, tables: 0 },
      operational: { payloadBytes: 0, allocatedBytes: 0, tables: 0 },
    }

    try {
      const tables = this.db.prepare(`
        SELECT m.tbl_name AS tableName,
               COALESCE(SUM(s.payload), 0) AS payloadBytes,
               COALESCE(SUM(s.pgsize), 0) AS allocatedBytes
        FROM dbstat s
        JOIN sqlite_master m ON m.name = s.name
        WHERE m.type IN ('table', 'index')
        GROUP BY m.tbl_name
        ORDER BY allocatedBytes DESC, tableName
      `).all().map(value => {
        const row = rowRecord(value)
        const tableName = optionalString(row, 'tableName')
        if (!tableName) throw new TypeError('SQLite dbstat tableName must be a string')
        return {
          tableName,
          category: storageCategoryForTable(tableName),
          payloadBytes: requiredNumber(row, 'payloadBytes'),
          allocatedBytes: requiredNumber(row, 'allocatedBytes'),
        }
      })

      for (const table of tables) {
        const category = categories[table.category]
        category.payloadBytes += table.payloadBytes
        category.allocatedBytes += table.allocatedBytes
        category.tables += 1
      }
      return { available: true, categories, tables }
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        categories,
        tables: [],
      }
    }
  }

  private growthDiagnosticsDetails() {
    const now = Date.now()
    const cutoff7 = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
    const cutoff30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
    const params = { cutoff7, cutoff30 }

    const aggregateSql = `
      WITH metrics AS (
        SELECT source_id AS sourceId,
               installation_id AS installationId,
               'sourceRaw' AS kind,
               captured_at AS capturedAt,
               (
                 length(CAST(locator_json AS BLOB))
                 + length(CAST(payload_json AS BLOB))
                 + COALESCE(length(payload_blob), 0)
               ) AS approxBytes
        FROM source_records
        UNION ALL
        SELECT ss.source_id AS sourceId,
               o.installation_id AS installationId,
               'canonical' AS kind,
               o.captured_at AS capturedAt,
               length(CAST(o.payload_json AS BLOB)) AS approxBytes
        FROM observations o
        JOIN source_sessions ss ON ss.id = o.source_session_id
        UNION ALL
        SELECT COALESCE(sr.source_id, 'unattributed') AS sourceId,
               sr.installation_id AS installationId,
               'evidence' AS kind,
               e.captured_at AS capturedAt,
               COALESCE(length(CAST(e.source_locator_json AS BLOB)), 0) AS approxBytes
        FROM evidence e
        LEFT JOIN source_records sr ON sr.id = e.source_record_id
      )
    `

    const mapGrowthRow = (value: unknown, key: 'sourceId' | 'productId') => {
      const row = rowRecord(value)
      const id = optionalString(row, key)
      if (!id) throw new TypeError(`SQLite growth diagnostic field ${key} must be a string`)
      return {
        [key]: id,
        ...(key === 'productId' ? { productName: optionalString(row, 'productName') } : {}),
        total: {
          records: requiredNumber(row, 'totalRecords'),
          approxBytes: requiredNumber(row, 'totalBytes'),
        },
        last7Days: {
          records: requiredNumber(row, 'last7Records'),
          approxBytes: requiredNumber(row, 'last7Bytes'),
        },
        last30Days: {
          records: requiredNumber(row, 'last30Records'),
          approxBytes: requiredNumber(row, 'last30Bytes'),
        },
        byKind: {
          sourceRaw: {
            records: requiredNumber(row, 'sourceRawRecords'),
            approxBytes: requiredNumber(row, 'sourceRawBytes'),
          },
          canonical: {
            records: requiredNumber(row, 'canonicalRecords'),
            approxBytes: requiredNumber(row, 'canonicalBytes'),
          },
          evidence: {
            records: requiredNumber(row, 'evidenceRecords'),
            approxBytes: requiredNumber(row, 'evidenceBytes'),
          },
        },
      }
    }

    const bySource = this.db.prepare(`
      ${aggregateSql}
      SELECT sourceId,
             COUNT(*) AS totalRecords,
             COALESCE(SUM(approxBytes), 0) AS totalBytes,
             SUM(CASE WHEN capturedAt >= @cutoff7 THEN 1 ELSE 0 END) AS last7Records,
             COALESCE(SUM(CASE WHEN capturedAt >= @cutoff7 THEN approxBytes ELSE 0 END), 0) AS last7Bytes,
             SUM(CASE WHEN capturedAt >= @cutoff30 THEN 1 ELSE 0 END) AS last30Records,
             COALESCE(SUM(CASE WHEN capturedAt >= @cutoff30 THEN approxBytes ELSE 0 END), 0) AS last30Bytes,
             SUM(CASE WHEN kind = 'sourceRaw' THEN 1 ELSE 0 END) AS sourceRawRecords,
             COALESCE(SUM(CASE WHEN kind = 'sourceRaw' THEN approxBytes ELSE 0 END), 0) AS sourceRawBytes,
             SUM(CASE WHEN kind = 'canonical' THEN 1 ELSE 0 END) AS canonicalRecords,
             COALESCE(SUM(CASE WHEN kind = 'canonical' THEN approxBytes ELSE 0 END), 0) AS canonicalBytes,
             SUM(CASE WHEN kind = 'evidence' THEN 1 ELSE 0 END) AS evidenceRecords,
             COALESCE(SUM(CASE WHEN kind = 'evidence' THEN approxBytes ELSE 0 END), 0) AS evidenceBytes
      FROM metrics
      GROUP BY sourceId
      ORDER BY last30Bytes DESC, totalBytes DESC, sourceId
    `).all(params).map(value => mapGrowthRow(value, 'sourceId'))

    const byAgent = this.db.prepare(`
      ${aggregateSql}
      SELECT ai.product_id AS productId,
             ap.name AS productName,
             COUNT(*) AS totalRecords,
             COALESCE(SUM(metrics.approxBytes), 0) AS totalBytes,
             SUM(CASE WHEN metrics.capturedAt >= @cutoff7 THEN 1 ELSE 0 END) AS last7Records,
             COALESCE(SUM(CASE WHEN metrics.capturedAt >= @cutoff7 THEN metrics.approxBytes ELSE 0 END), 0) AS last7Bytes,
             SUM(CASE WHEN metrics.capturedAt >= @cutoff30 THEN 1 ELSE 0 END) AS last30Records,
             COALESCE(SUM(CASE WHEN metrics.capturedAt >= @cutoff30 THEN metrics.approxBytes ELSE 0 END), 0) AS last30Bytes,
             SUM(CASE WHEN metrics.kind = 'sourceRaw' THEN 1 ELSE 0 END) AS sourceRawRecords,
             COALESCE(SUM(CASE WHEN metrics.kind = 'sourceRaw' THEN metrics.approxBytes ELSE 0 END), 0) AS sourceRawBytes,
             SUM(CASE WHEN metrics.kind = 'canonical' THEN 1 ELSE 0 END) AS canonicalRecords,
             COALESCE(SUM(CASE WHEN metrics.kind = 'canonical' THEN metrics.approxBytes ELSE 0 END), 0) AS canonicalBytes,
             SUM(CASE WHEN metrics.kind = 'evidence' THEN 1 ELSE 0 END) AS evidenceRecords,
             COALESCE(SUM(CASE WHEN metrics.kind = 'evidence' THEN metrics.approxBytes ELSE 0 END), 0) AS evidenceBytes
      FROM metrics
      JOIN agent_installations ai ON ai.id = metrics.installationId
      JOIN agent_products ap ON ap.id = ai.product_id
      GROUP BY ai.product_id, ap.name
      ORDER BY last30Bytes DESC, totalBytes DESC, productId
    `).all(params).map(value => mapGrowthRow(value, 'productId'))

    const dailyRows = this.db.prepare(`
      ${aggregateSql}
      SELECT substr(capturedAt, 1, 10) AS day,
             COUNT(*) AS records,
             COALESCE(SUM(approxBytes), 0) AS approxBytes,
             SUM(CASE WHEN kind = 'sourceRaw' THEN 1 ELSE 0 END) AS sourceRawRecords,
             SUM(CASE WHEN kind = 'canonical' THEN 1 ELSE 0 END) AS canonicalRecords,
             SUM(CASE WHEN kind = 'evidence' THEN 1 ELSE 0 END) AS evidenceRecords,
             COALESCE(SUM(CASE WHEN kind = 'sourceRaw' THEN approxBytes ELSE 0 END), 0) AS sourceRawBytes,
             COALESCE(SUM(CASE WHEN kind = 'canonical' THEN approxBytes ELSE 0 END), 0) AS canonicalBytes,
             COALESCE(SUM(CASE WHEN kind = 'evidence' THEN approxBytes ELSE 0 END), 0) AS evidenceBytes
      FROM metrics
      WHERE capturedAt >= @cutoff30
      GROUP BY substr(capturedAt, 1, 10)
      ORDER BY day
    `).all(params).map(value => {
      const row = rowRecord(value)
      return {
        day: optionalString(row, 'day') ?? '',
        records: requiredNumber(row, 'records'),
        approxBytes: requiredNumber(row, 'approxBytes'),
        sourceRawRecords: requiredNumber(row, 'sourceRawRecords'),
        canonicalRecords: requiredNumber(row, 'canonicalRecords'),
        evidenceRecords: requiredNumber(row, 'evidenceRecords'),
        sourceRawBytes: requiredNumber(row, 'sourceRawBytes'),
        canonicalBytes: requiredNumber(row, 'canonicalBytes'),
        evidenceBytes: requiredNumber(row, 'evidenceBytes'),
      }
    })
    const dailyByDay = new Map(dailyRows.map(item => [item.day, item]))
    const last30Days = Array.from({ length: 30 }, (_, index) => {
      const day = new Date(now - (29 - index) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      return dailyByDay.get(day) ?? {
        day,
        records: 0,
        approxBytes: 0,
        sourceRawRecords: 0,
        canonicalRecords: 0,
        evidenceRecords: 0,
        sourceRawBytes: 0,
        canonicalBytes: 0,
        evidenceBytes: 0,
      }
    })

    const windowMetrics = (cutoff: string) => {
      const row = rowRecord(this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM source_records WHERE captured_at >= @cutoff) AS sourceRawRecords,
          (SELECT COALESCE(SUM(
             length(CAST(locator_json AS BLOB))
             + length(CAST(payload_json AS BLOB))
             + COALESCE(length(payload_blob), 0)
           ), 0) FROM source_records WHERE captured_at >= @cutoff) AS sourceRawBytes,
          (SELECT COUNT(*) FROM observations WHERE captured_at >= @cutoff) AS canonicalRecords,
          (SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0)
             FROM observations WHERE captured_at >= @cutoff) AS canonicalBytes,
          (SELECT COUNT(*) FROM evidence WHERE captured_at >= @cutoff) AS evidenceRecords,
          (SELECT COALESCE(SUM(COALESCE(length(CAST(source_locator_json AS BLOB)), 0)), 0)
             FROM evidence WHERE captured_at >= @cutoff) AS evidenceBytes,
          (
            (SELECT COALESCE(SUM(
               COALESCE(length(CAST(first_user_payload AS BLOB)), 0)
               + length(CAST(source_ids_json AS BLOB))
             ), 0) FROM session_summary_projection WHERE ended_at >= @cutoff)
            + (SELECT COALESCE(SUM(
               length(CAST(observation_id AS BLOB))
               + length(CAST(source_id AS BLOB))
               + length(CAST(native_type AS BLOB))
             ), 0) FROM unknown_observation_projection WHERE last_seen_at >= @cutoff)
            + (SELECT COALESCE(SUM(
               length(CAST(observation_id AS BLOB))
               + length(CAST(source_id AS BLOB))
               + length(CAST(product_id AS BLOB))
               + COALESCE(length(CAST(tool_name AS BLOB)), 0)
               + COALESCE(length(CAST(call_id AS BLOB)), 0)
               + COALESCE(length(CAST(skill_name AS BLOB)), 0)
             ), 0) FROM tool_usage_fact_projection WHERE effective_at >= @cutoff)
          ) AS projectionBytes
      `).get({ cutoff }))
      const sourceRawBytes = requiredNumber(row, 'sourceRawBytes')
      const canonicalBytes = requiredNumber(row, 'canonicalBytes')
      const evidenceBytes = requiredNumber(row, 'evidenceBytes')
      const projectionBytes = requiredNumber(row, 'projectionBytes')
      const durableApproxBytes = sourceRawBytes + canonicalBytes + evidenceBytes + projectionBytes
      return {
        sourceRawRecords: requiredNumber(row, 'sourceRawRecords'),
        sourceRawBytes,
        canonicalRecords: requiredNumber(row, 'canonicalRecords'),
        canonicalBytes,
        evidenceRecords: requiredNumber(row, 'evidenceRecords'),
        evidenceBytes,
        projectionBytes,
        durableApproxBytes,
        storageAmplificationRate: ratioOrNull(durableApproxBytes, sourceRawBytes),
      }
    }
    const sevenDays = windowMetrics(cutoff7)
    const thirtyDays = windowMetrics(cutoff30)

    return {
      cutoffs: { last7Days: cutoff7, last30Days: cutoff30 },
      bySource,
      byAgent,
      trend: {
        last7Days: last30Days.slice(-7),
        last30Days,
      },
      metrics: {
        canonicalGrowthRate: {
          basis: 'canonical-observations-captured',
          last7Days: {
            observationsPerDay: sevenDays.canonicalRecords / 7,
            approxBytesPerDay: sevenDays.canonicalBytes / 7,
          },
          last30Days: {
            observationsPerDay: thirtyDays.canonicalRecords / 30,
            approxBytesPerDay: thirtyDays.canonicalBytes / 30,
          },
        },
        storageAmplificationRate: {
          basis: 'durable-logical-growth/source-raw-growth',
          last7Days: sevenDays.storageAmplificationRate,
          last30Days: thirtyDays.storageAmplificationRate,
          windows: {
            last7Days: sevenDays,
            last30Days: thirtyDays,
          },
        },
      },
    }
  }

  private checkpointHealthDetails() {
    const checkpointTable = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_checkpoints'
    `).get()
    const summary = checkpointTable
      ? checkpointSummaryRow(this.db.prepare(`
          SELECT COUNT(*) AS count, MAX(updated_at) AS lastUpdatedAt
          FROM source_checkpoints
        `).get())
      : { count: 0, lastUpdatedAt: null }
    return summary
  }

  async health(): Promise<StorageHealth> {
    return this.executor.run(() => ({
      ok: probeOk(this.db.prepare('SELECT 1 AS ok').get()),
      schemaVersion: this.schemaVersion(),
      details: {
        path: this.db.name,
        readonly: this.db.readonly,
        inTransaction: this.db.inTransaction,
        executor: this.executor.metrics(),
        sourceRuntime: this.runtimeHealthDetails(),
        dataGrowth: this.capacityDetails(),
        checkpoints: this.checkpointHealthDetails(),
      },
    }))
  }

  async diagnostics(): Promise<StorageHealth> {
    const health = await this.health()
    const unknownObservations = await this.unknownObservationProjection.summary()
    const toolUsageFacts = await this.projectionBackfill.toolUsageFactCoverage()
    return this.executor.run(() => {
      const coverageItems = this.db.prepare(`
        SELECT subject_type AS subjectType,
               subject_id AS subjectId,
               capability,
               from_time AS "from",
               to_time AS "to",
               status,
               reason
        FROM coverage
        ORDER BY subject_type, subject_id, capability, COALESCE(to_time, from_time) DESC
        LIMIT 300
      `).all().map(rowRecord)
      const coverageSummary = { complete: 0, partial: 0, unavailable: 0, unknown: 0 }
      for (const item of coverageItems) {
        const status = coverageStatus(item)
        if (status) coverageSummary[status] += 1
      }

      const growth = this.growthDiagnosticsDetails()
      const breakdown = this.storageBreakdownDetails()
      const baseGrowth = readonlyRecord(health.details?.dataGrowth) ?? this.capacityDetails()
      const projectionAllocatedBytes = breakdown.categories.projection.allocatedBytes
      const walBytes = typeof baseGrowth.walBytes === 'number' ? baseGrowth.walBytes : 0
      const tempAllocatedBytes = typeof baseGrowth.tempAllocatedBytes === 'number'
        ? baseGrowth.tempAllocatedBytes
        : 0
      const freelistBytes = typeof baseGrowth.reclaimableBytes === 'number'
        ? baseGrowth.reclaimableBytes
        : 0

      return {
        ...health,
        details: {
          ...health.details,
          unknownObservations,
          toolUsageFacts: {
            state: toolUsageFacts.ready ? 'ready' : 'partial',
            ...toolUsageFacts,
          },
          coverage: {
            summary: coverageSummary,
            items: coverageItems,
          },
          storageBreakdown: breakdown,
          reclaimableSpace: {
            estimateOnly: true,
            freelistBytes,
            walBytes,
            tempAllocatedBytes,
            rebuildableProjectionBytes: projectionAllocatedBytes,
            estimatedBytes: freelistBytes + walBytes + tempAllocatedBytes + projectionAllocatedBytes,
            excludesSourceRaw: true,
            reason: 'Phase 1 does not infer Source Raw recoverability before Source capability governance is implemented.',
          },
          dataGrowth: {
            ...baseGrowth,
            thirtyDayCutoff: growth.cutoffs.last30Days,
            sevenDayCutoff: growth.cutoffs.last7Days,
            bySource: growth.bySource,
            byAgent: growth.byAgent,
            trend: growth.trend,
            metrics: growth.metrics,
          },
        },
      }
    })
  }

  async close(): Promise<void> {
    await this.executor.close()
  }
}
