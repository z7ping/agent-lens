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
import { migrateDatabase } from './migrations'
import { withSqliteObservationPagination } from './observation-pagination'
import { createSqliteRepositories } from './repositories'
import { SqliteReplicationCanonicalChangeReader } from './replication-canonical-changes'
import { SqliteReplicationStateRepository } from './replication-state'
import { SqliteSessionRelationshipCandidateRepository } from './relationship-candidates'
import { SqliteRuntimeProfileRepository } from './runtime-profiles'
import { SqliteSourceRuntimeStatusRepository } from './runtime-status'
import { SqliteSessionSummaryReader } from './session-summaries'
import { SqliteToolUsageObservationReader } from './tool-usage-observations'

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
    const repositories = createSqliteRepositories(this.executor)
    this.repositories = {
      ...repositories,
      observations: withSqliteObservationPagination(this.executor, repositories.observations),
    }
    this.checkpoints = new SqliteCheckpointRepository(this.executor)
    this.assetInventory = new SqliteAssetInventoryReader(this.executor)
    const sessionSummaries = new SqliteSessionSummaryReader(this.executor)
    this.sessionSummaries = sessionSummaries
    this.sessionSummaryProjection = sessionSummaries
    this.toolUsageObservations = new SqliteToolUsageObservationReader(this.executor)
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

  async health(): Promise<StorageHealth> {
    return this.executor.run(() => {
      const probe = this.db.prepare('SELECT 1 AS ok').get() as { ok: number }
      const migrationTable = this.db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
      `).get()
      const schemaVersion = migrationTable
        ? Number((this.db.prepare(
          'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations',
        ).get() as { version: number }).version)
        : 0
      const runtimeStatusTable = this.db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_runtime_status'
      `).get()
      const sourceRuntime = runtimeStatusTable
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
      const failedSources = (sourceRuntime as Array<{ state: string }>).filter(item => item.state === 'failed').length
      const runningSources = (sourceRuntime as Array<{ state: string }>).filter(item => item.state === 'running').length

      const unknownObservations = this.db.prepare(`
        SELECT sr.source_id AS sourceId,
               sr.native_type AS nativeType,
               COUNT(DISTINCT o.id) AS count,
               MAX(COALESCE(o.occurred_at, o.captured_at)) AS lastSeenAt
        FROM observations o
        JOIN observation_evidence oe ON oe.observation_id = o.id
        JOIN evidence e ON e.id = oe.evidence_id
        JOIN source_records sr ON sr.id = e.source_record_id
        WHERE o.kind = 'unknown'
        GROUP BY sr.source_id, sr.native_type
        ORDER BY count DESC, sr.source_id, sr.native_type
        LIMIT 100
      `).all()
      const unknownCount = (unknownObservations as Array<{ count: number }>).reduce(
        (sum, item) => sum + Number(item.count || 0),
        0,
      )

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
      const count = (table: string): number => Number((this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
      const recentCount = (table: string, column: string): number => Number((this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} >= ?`).get(cutoff) as { count: number }).count)
      const pageCount = Number(this.db.pragma('page_count', { simple: true }))
      const pageSize = Number(this.db.pragma('page_size', { simple: true }))
      const databaseBytes = fileSize(this.db.name)
      const walBytes = fileSize(`${this.db.name}-wal`)
      const checkpointTable = this.db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_checkpoints'
      `).get()
      const checkpointSummary = checkpointTable
        ? this.db.prepare(`
            SELECT COUNT(*) AS count, MAX(updated_at) AS lastUpdatedAt
            FROM source_checkpoints
          `).get() as { count: number; lastUpdatedAt: string | null }
        : { count: 0, lastUpdatedAt: null }

      const dataGrowth = {
        databaseBytes,
        walBytes,
        logicalBytes: pageCount * pageSize,
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
          sessions: Number((this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM logical_sessions
            WHERE COALESCE(started_at, ended_at) >= ?
          `).get(cutoff) as { count: number }).count),
        },
      }

      return {
        ok: probe.ok === 1,
        schemaVersion,
        details: {
          path: this.db.name,
          readonly: this.db.readonly,
          inTransaction: this.db.inTransaction,
          sourceRuntime: {
            failed: failedSources,
            running: runningSources,
            items: sourceRuntime,
          },
          unknownObservations: {
            total: unknownCount,
            groups: unknownObservations,
          },
          coverage: {
            summary: coverageSummary,
            items: coverageItems,
          },
          dataGrowth,
          checkpoints: {
            count: Number(checkpointSummary.count || 0),
            lastUpdatedAt: checkpointSummary.lastUpdatedAt,
          },
        },
      }
    })
  }

  async close(): Promise<void> {
    await this.executor.close()
  }
}
