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
import { SqliteReplicationBootstrapLifecycleRepository } from './replication-bootstrap-lifecycle'
import { SqliteReplicationCanonicalChangeReader } from './replication-canonical-changes'
import { SqliteReplicationChangeProgressRepository } from './replication-change-progress'
import { SqliteReplicationJournalLifecycleRepository } from './replication-journal-lifecycle'
import { SqliteCanonicalObservationSnapshotReader } from './replication-observation-snapshot'
import { SqliteReplicationSnapshotBootstrapProgressRepository } from './replication-snapshot-bootstrap-progress'
import { SqliteReplicationRuntimeControlRepository } from './replication-runtime-control'
import { SqliteReplicationStateRepository } from './replication-state'
import { SqliteSessionRelationshipCandidateRepository } from './relationship-candidates'
import { SqliteRuntimeProfileRepository } from './runtime-profiles'
import { SqliteSourceRuntimeStatusRepository } from './runtime-status'
import { SqliteSourceRawAuditReader } from './source-raw-audit'
import { withSqliteSessionRuntimeProfiles } from './session-runtime-profile'
import { SqliteSessionSummaryReader } from './session-summaries-v2'
import { withSqliteSourceRecordCompression } from './source-record-compression'
import {
  capturedActivityDetails,
  largePayloadProfile,
  replicationJournalDetails,
  sourceActivityPayloadBytesBetween,
  storageBreakdownDetails,
} from './storage-diagnostics'
import {
  STORAGE_DIAGNOSTIC_SNAPSHOT_KEY,
  STORAGE_DIAGNOSTIC_SNAPSHOT_RETENTION_DAYS,
  STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE,
  parseStorageDiagnosticSnapshotSeries,
  storageGrowthMetricsFromSnapshots,
  type StorageDiagnosticSnapshot,
} from './storage-diagnostic-snapshots'
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
  readonly sourceRawAudit: SqliteSourceRawAuditReader
  readonly sessionRelationshipCandidates: SqliteSessionRelationshipCandidateRepository
  readonly replication: SqliteReplicationStateRepository
  readonly replicationBootstrapLifecycle: SqliteReplicationBootstrapLifecycleRepository
  readonly replicationCanonicalChanges: SqliteReplicationCanonicalChangeReader
  readonly replicationChangeProgress: SqliteReplicationChangeProgressRepository
  readonly replicationJournalLifecycle: SqliteReplicationJournalLifecycleRepository
  readonly replicationObservationSnapshot: SqliteCanonicalObservationSnapshotReader
  readonly replicationSnapshotBootstrapProgress: SqliteReplicationSnapshotBootstrapProgressRepository
  readonly replicationRuntimeControl: SqliteReplicationRuntimeControlRepository
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
    this.sourceRawAudit = new SqliteSourceRawAuditReader(this.executor)
    this.sessionRelationshipCandidates = new SqliteSessionRelationshipCandidateRepository(this.executor)
    this.replication = new SqliteReplicationStateRepository(this.executor)
    this.replicationBootstrapLifecycle = new SqliteReplicationBootstrapLifecycleRepository(this.executor)
    this.replicationCanonicalChanges = new SqliteReplicationCanonicalChangeReader(this.executor)
    this.replicationChangeProgress = new SqliteReplicationChangeProgressRepository(this.executor)
    this.replicationJournalLifecycle = new SqliteReplicationJournalLifecycleRepository(this.executor)
    this.replicationObservationSnapshot = new SqliteCanonicalObservationSnapshotReader(this.executor)
    this.replicationSnapshotBootstrapProgress = new SqliteReplicationSnapshotBootstrapProgressRepository(this.executor)
    this.replicationRuntimeControl = new SqliteReplicationRuntimeControlRepository(this.executor)
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
    const freelistBytes = freelistCount * pageSize
    let sqliteTempAllocatedBytes = 0
    try {
      const tempPageCount = Number(this.db.pragma('temp.page_count', { simple: true }))
      const tempPageSize = Number(this.db.pragma('temp.page_size', { simple: true }))
      sqliteTempAllocatedBytes = tempPageCount * tempPageSize
    } catch {
      // SQLite TEMP schema may not exist until a connection actually uses it.
    }
    const hotFootprintBytes = Math.max(databaseBytes, logicalBytes) + walBytes
    return {
      databaseBytes,
      walBytes,
      shmBytes,
      logicalBytes,
      databaseAllocatedBytes: logicalBytes,
      freelistBytes,
      // Backwards-compatible alias. This means reusable pages inside SQLite,
      // not bytes that can be subtracted from the database file immediately.
      reclaimableBytes: freelistBytes,
      sqliteTempAllocatedBytes,
      tempScope: 'sqlite-temp-schema',
      totalDiskBytes: databaseBytes + walBytes + shmBytes,
      hotFootprintBytes,
      capacity: {
        ...describeStorageCapacity(hotFootprintBytes),
        scope: 'hot-sqlite',
        longTermTotalLimitBytes: null,
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
    const persistedSnapshots = await this.checkpoints.get<unknown>(
      STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE,
      STORAGE_DIAGNOSTIC_SNAPSHOT_KEY,
    )
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

      const activity = capturedActivityDetails(this.db)
      const breakdown = storageBreakdownDetails(this.db)
      const largePayloads = largePayloadProfile(this.db)
      const replicationJournal = replicationJournalDetails(
        this.db,
        activity.cutoffs.last7Days,
        activity.cutoffs.last30Days,
      )
      const baseGrowth = readonlyRecord(health.details?.dataGrowth) ?? this.capacityDetails()
      const projectionAllocatedBytes = breakdown.categories.projection.allocatedBytes
      const walBytes = typeof baseGrowth.walBytes === 'number' ? baseGrowth.walBytes : 0
      const sqliteTempAllocatedBytes = typeof baseGrowth.sqliteTempAllocatedBytes === 'number'
        ? baseGrowth.sqliteTempAllocatedBytes
        : 0
      const freelistBytes = typeof baseGrowth.freelistBytes === 'number'
        ? baseGrowth.freelistBytes
        : typeof baseGrowth.reclaimableBytes === 'number'
          ? baseGrowth.reclaimableBytes
          : 0
      const count = (tableName: string): number => countRow(this.db.prepare(
        `SELECT COUNT(*) AS count FROM ${tableName}`,
      ).get())
      const totals = {
        sourceRecords: count('source_records'),
        observations: count('observations'),
        evidence: count('evidence'),
        sessions: count('logical_sessions'),
      }
      const snapshotCapturedAt = new Date().toISOString()
      const persistedSeries = parseStorageDiagnosticSnapshotSeries(persistedSnapshots)
      const previousSnapshot = persistedSeries.snapshots.at(-1) ?? null
      const measuredSourceActivity = previousSnapshot
        ? sourceActivityPayloadBytesBetween(
            this.db,
            previousSnapshot.capturedAt,
            snapshotCapturedAt,
          )
        : null
      const netNewSourceRecords = previousSnapshot
        ? totals.sourceRecords - previousSnapshot.counts.sourceRecords
        : 0
      const sourceActivityInterval = !previousSnapshot
        ? {
            state: 'baseline' as const,
            basis: 'persisted-source-record-payload-json-before-compression',
            records: 0,
            originalPayloadBytes: 0,
            netNewSourceRecords: 0,
            unknownEncodingRecords: 0,
            invalidPayloadRecords: 0,
            gzipSizeBasis: 'gzip-isize-uint32',
          }
        : measuredSourceActivity!.state === 'complete'
          && netNewSourceRecords >= 0
          && measuredSourceActivity!.records === netNewSourceRecords
          ? {
              ...measuredSourceActivity!,
              state: 'complete' as const,
              netNewSourceRecords,
            }
          : {
              ...measuredSourceActivity!,
              state: 'partial' as const,
              netNewSourceRecords,
              reason: measuredSourceActivity!.state !== 'complete'
                ? 'source-payload-accounting-incomplete'
                : netNewSourceRecords < 0
                  ? 'source-record-count-decreased'
                  : 'recent-source-records-do-not-match-net-new-records',
            }
      const sourceActivity = previousSnapshot && sourceActivityInterval.state === 'complete'
        ? {
            epochCapturedAt: previousSnapshot.sourceActivity.epochCapturedAt,
            originalPayloadBytesCumulative:
              previousSnapshot.sourceActivity.originalPayloadBytesCumulative
              + sourceActivityInterval.originalPayloadBytes,
            recordsCumulative:
              previousSnapshot.sourceActivity.recordsCumulative
              + sourceActivityInterval.records,
          }
        : {
            epochCapturedAt: snapshotCapturedAt,
            originalPayloadBytesCumulative: 0,
            recordsCumulative: 0,
          }
      const databaseBytes = typeof baseGrowth.databaseBytes === 'number'
        ? baseGrowth.databaseBytes
        : 0
      const databaseAllocatedBytes = typeof baseGrowth.databaseAllocatedBytes === 'number'
        ? baseGrowth.databaseAllocatedBytes
        : databaseBytes
      const persistentRetainedBytes = Math.max(databaseBytes, databaseAllocatedBytes)
      const currentSnapshot: StorageDiagnosticSnapshot | null = breakdown.available
        ? {
            version: 2,
            day: snapshotCapturedAt.slice(0, 10),
            capturedAt: snapshotCapturedAt,
            hotFootprintBytes: typeof baseGrowth.hotFootprintBytes === 'number'
              ? baseGrowth.hotFootprintBytes
              : 0,
            databaseBytes,
            persistentRetainedBytes,
            persistentRetainedScope: 'sqlite-main',
            walBytes,
            counts: totals,
            categoryAllocatedBytes: {
              canonical: breakdown.categories.canonical.allocatedBytes,
              evidence: breakdown.categories.evidence.allocatedBytes,
              sourceRaw: breakdown.categories.sourceRaw.allocatedBytes,
              projection: breakdown.categories.projection.allocatedBytes,
              replication: breakdown.categories.replication.allocatedBytes,
              operational: breakdown.categories.operational.allocatedBytes,
            },
            replicationChanges: replicationJournal.totalChanges,
            sourceActivity,
          }
        : null
      const growthMetrics = storageGrowthMetricsFromSnapshots(
        currentSnapshot,
        persistedSnapshots,
      )

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
          largePayloads,
          spaceRecovery: {
            freelist: {
              bytes: freelistBytes,
              reusableInsideDatabase: true,
              shrinksDatabaseFileWithoutCompaction: false,
            },
            wal: {
              bytes: walBytes,
              releaseDependsOnCheckpoint: true,
            },
            sqliteTempSchema: {
              bytes: sqliteTempAllocatedBytes,
              lifecycle: 'connection-scoped',
            },
            projection: {
              allocatedBytes: projectionAllocatedBytes,
              rebuildable: true,
              physicalReleaseRequiresDeleteAndCompaction: true,
            },
            sourceRaw: {
              state: 'not-assessed',
              reason: 'Phase 2 Source recoverability governance is required before Raw can be counted as safely reclaimable.',
            },
          },
          capturedActivity: activity,
          replicationJournal,
          storageSnapshot: {
            scope: STORAGE_DIAGNOSTIC_SNAPSHOT_SCOPE,
            key: STORAGE_DIAGNOSTIC_SNAPSHOT_KEY,
            retentionDays: STORAGE_DIAGNOSTIC_SNAPSHOT_RETENTION_DAYS,
            current: currentSnapshot,
            history: growthMetrics.history,
            sourceActivityInterval,
          },
          growthMetrics,
          dataGrowth: {
            ...baseGrowth,
            thirtyDayCutoff: activity.cutoffs.last30Days,
            sevenDayCutoff: activity.cutoffs.last7Days,
            totals,
            last7Days: {
              sourceRecords: activity.sourceRaw.last7Days.records,
              observations: activity.canonical.available ? activity.canonical.last7Days?.records ?? null : null,
              evidence: activity.evidence.available ? activity.evidence.last7Days?.records ?? null : null,
              sessions: activity.sessions.available ? activity.sessions.last7Days?.records ?? null : null,
            },
            last30Days: {
              sourceRecords: activity.sourceRaw.last30Days.records,
              observations: activity.canonical.available ? activity.canonical.last30Days?.records ?? null : null,
              evidence: activity.evidence.available ? activity.evidence.last30Days?.records ?? null : null,
              sessions: activity.sessions.available ? activity.sessions.last30Days?.records ?? null : null,
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
