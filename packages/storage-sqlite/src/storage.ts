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
  readonly sessionSummaries: SqliteSessionSummaryReader
  readonly sessionSummaryProjection: SqliteSessionSummaryReader
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
    const sessionSummaries = new SqliteSessionSummaryReader(this.executor)
    this.sessionSummaries = sessionSummaries
    this.sessionSummaryProjection = sessionSummaries
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
      ? Number((this.db.prepare(
        'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
      ).get() as { version: number }).version)
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
        `).all()
      : []
    const typed = items as Array<{ state: string }>
    return {
      failed: typed.filter(item => item.state === 'failed').length,
      running: typed.filter(item => item.state === 'running').length,
      items,
    }
  }

  private capacityDetails() {
    const pageCount = Number(this.db.pragma('page_count', { simple: true }))
    const pageSize = Number(this.db.pragma('page_size', { simple: true }))
    const freelistCount = Number(this.db.pragma('freelist_count', { simple: true }))
    const databaseBytes = fileSize(this.db.name)
    const walBytes = fileSize(`${this.db.name}-wal`)
    const logicalBytes = pageCount * pageSize
    const reclaimableBytes = freelistCount * pageSize
    return {
      databaseBytes,
      walBytes,
      logicalBytes,
      reclaimableBytes,
      capacity: describeStorageCapacity(Math.max(databaseBytes, logicalBytes) + walBytes),
    }
  }

  private checkpointHealthDetails() {
    const checkpointTable = this.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_checkpoints'
    `).get()
    const summary = checkpointTable
      ? this.db.prepare(`
          SELECT COUNT(*) AS count, MAX(updated_at) AS lastUpdatedAt
          FROM source_checkpoints
        `).get() as { count: number; lastUpdatedAt: string | null }
      : { count: 0, lastUpdatedAt: null }
    return {
      count: Number(summary.count || 0),
      lastUpdatedAt: summary.lastUpdatedAt,
    }
  }

  async health(): Promise<StorageHealth> {
    return this.executor.run(() => {
      const probe = this.db.prepare('SELECT 1 AS ok').get() as { ok: number }
      return {
        ok: probe.ok === 1,
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
      }
    })
  }

  async diagnostics(): Promise<StorageHealth> {
    const health = await this.health()
    const unknownObservations = await this.unknownObservationProjection.summary()
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
      `).all()
      const coverageSummary = { complete: 0, partial: 0, unavailable: 0, unknown: 0 }
      for (const item of coverageItems as Array<{ status: keyof typeof coverageSummary }>) {
        if (item.status in coverageSummary) coverageSummary[item.status] += 1
      }

      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const count = (table: string): number => Number((this.db.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).get() as { count: number }).count)
      const recentCount = (table: string, column: string): number => Number((this.db.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} >= ?`,
      ).get(cutoff) as { count: number }).count)
      const recentSessions = Number((this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM session_summary_projection
        WHERE ended_at >= ?
      `).get(cutoff) as { count: number }).count)
      const baseGrowth = health.details?.dataGrowth && typeof health.details.dataGrowth === 'object'
        ? health.details.dataGrowth as Readonly<Record<string, unknown>>
        : this.capacityDetails()

      return {
        ...health,
        details: {
          ...health.details,
          unknownObservations,
          coverage: {
            summary: coverageSummary,
            items: coverageItems,
          },
          dataGrowth: {
            ...baseGrowth,
            sevenDayCutoff: cutoff,
            totals: {
              sourceRecords: count('source_records'),
              observations: count('observations'),
              evidence: count('evidence'),
              sessions: count('logical_sessions'),
            },
            last7Days: {
              sourceRecords: recentCount('source_records', 'captured_at'),
              observations: recentCount('observations', 'captured_at'),
              evidence: recentCount('evidence', 'captured_at'),
              sessions: recentSessions,
            },
          },
        },
      }
    })
  }

  async close(): Promise<void> {
    await this.executor.close()
  }
}
