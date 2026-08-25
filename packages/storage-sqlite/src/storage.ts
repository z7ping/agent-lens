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
import { SqliteSessionRelationshipCandidateRepository } from './relationship-candidates'
import { SqliteRuntimeProfileRepository } from './runtime-profiles'
import { SqliteSourceRuntimeStatusRepository } from './runtime-status'
import { SqliteSessionSummaryReader } from './session-summaries'

export interface SqliteStorageOptions {
  path: string
  readonly?: boolean
}

export class SqliteStorageService implements StorageService {
  readonly db: Database.Database
  readonly repositories: RepositorySet
  readonly checkpoints: CheckpointRepository
  readonly assetInventory: SqliteAssetInventoryReader
  readonly sessionSummaries: SqliteSessionSummaryReader
  readonly runtimeProfiles: SqliteRuntimeProfileRepository
  readonly sourceRuntimeStatus: SqliteSourceRuntimeStatusRepository
  readonly sessionRelationshipCandidates: SqliteSessionRelationshipCandidateRepository
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
    this.sessionSummaries = new SqliteSessionSummaryReader(this.executor)
    this.runtimeProfiles = new SqliteRuntimeProfileRepository(this.executor)
    this.sourceRuntimeStatus = new SqliteSourceRuntimeStatusRepository(this.executor)
    this.sessionRelationshipCandidates = new SqliteSessionRelationshipCandidateRepository(this.executor)
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
        },
      }
    })
  }

  close(): void {
    if (this.db.open) this.db.close()
  }
}
