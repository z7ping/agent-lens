import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { RepositorySet } from '@agent-lens/core'
import { SqliteExecutor } from './executor'
import { mapHost, mapInstallation } from './repository-row-mappers'
import { SqliteNativeSessionCatalog } from './native-session-catalog'
import { SqliteSlimNativeSessionList } from './slim-native-session-list'
import { SqliteSlimNativeSessionContexts } from './slim-native-session-contexts'
import { SqliteSlimIdentityService } from './slim-identity-service'
import { SqliteSlimAssetService } from './slim-asset-service'
import { SqliteNativeSessionMetrics } from './native-session-metrics'
import { SqliteRuntimeProfileRepository } from './runtime-profiles'
import { SqliteAssetInventoryReader } from './asset-inventory'
import { SqliteCheckpointRepository } from './checkpoints'
import { SqliteLaunchableProjectReader } from './launchable-projects'
import { SqliteMaintenanceJobStore } from './maintenance-jobs'
import { assertSlimSchema, initializeSlimSchema } from './slim-schema'

/**
 * The replacement SQLite composition root: no Canonical Repositories,
 * Observations, Evidence, SessionSummary projections, replication journal,
 * Legacy Claims, old migration chain, or Legacy Writer are constructed.
 *
 * This is a SEPARATE service from SqliteStorageService until its consumers are
 * migrated. Never silently downgrade to a v38 database.
 */
export class SqliteSlimStorage {
  readonly executor: SqliteExecutor
  /** Minimal read-only identity port for NativeSessionReader; no Legacy
   * RepositorySet, event writer, or implicit Canonical persistence exists.
   */
  readonly repositories: {
    hosts: Pick<RepositorySet['hosts'],'get'>
    installations: Pick<RepositorySet['installations'],'get'>
  }
  readonly nativeSessionCatalog: SqliteNativeSessionCatalog
  readonly nativeSessionList: SqliteSlimNativeSessionList
  readonly nativeSessionContexts: SqliteSlimNativeSessionContexts
  readonly identity: SqliteSlimIdentityService
  readonly assets: SqliteSlimAssetService
  readonly nativeSessionMetrics: SqliteNativeSessionMetrics
  readonly runtimeProfiles: SqliteRuntimeProfileRepository
  readonly assetInventory: SqliteAssetInventoryReader
  readonly checkpoints: SqliteCheckpointRepository
  readonly launchableProjects: SqliteLaunchableProjectReader
  readonly maintenanceJobs: SqliteMaintenanceJobStore

  constructor(readonly db: Database.Database) {
    assertSlimSchema(db)
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    this.executor = new SqliteExecutor(db)
    const executor = this.executor
    this.repositories = {
      hosts: {
        get(id) {
          return executor.run(() => {
            const value = db.prepare('SELECT * FROM hosts WHERE id=?').get(id)
            return value ? mapHost(value) : null
          })
        },
      },
      installations: {
        get(id) {
          return executor.run(() => {
            const value = db.prepare('SELECT * FROM agent_installations WHERE id=?').get(id)
            return value ? mapInstallation(value) : null
          })
        },
      },
    }
    this.nativeSessionCatalog = new SqliteNativeSessionCatalog(this.executor)
    this.nativeSessionList = new SqliteSlimNativeSessionList(this.executor)
    this.nativeSessionContexts = new SqliteSlimNativeSessionContexts(this.executor)
    this.identity = new SqliteSlimIdentityService(this.executor)
    this.assets = new SqliteSlimAssetService(this.executor)
    this.nativeSessionMetrics = new SqliteNativeSessionMetrics(this.executor)
    this.runtimeProfiles = new SqliteRuntimeProfileRepository(this.executor)
    this.assetInventory = new SqliteAssetInventoryReader(this.executor)
    this.checkpoints = new SqliteCheckpointRepository(this.executor)
    this.launchableProjects = new SqliteLaunchableProjectReader(this.executor)
    this.maintenanceJobs = new SqliteMaintenanceJobStore(this.executor)
  }

  /** Opens ONLY a pre-existing slim database. A legacy database must fail. */
  static openExisting(path: string, readOnly = false): SqliteSlimStorage {
    const db = new Database(path, { readonly: readOnly, fileMustExist:true })
    try {
      return new SqliteSlimStorage(db)
    } catch (error) {
      db.close()
      throw error
    }
  }

  /** Creates a slim DB only on a new path. Never upgrades/overwrites old data. */
  static async createFresh(path: string): Promise<SqliteSlimStorage> {
    if (path === ':memory:') {
      const db = new Database(':memory:')
      try {
        await initializeSlimSchema(db)
        return new SqliteSlimStorage(db)
      } catch (error) {
        db.close()
        throw error
      }
    }
    const destination = resolve(path)
    await mkdir(dirname(destination), { recursive:true })
    const reserved = await open(destination,'wx',0o600)
    await reserved.close()
    const db = new Database(destination,{fileMustExist:true})
    try {
      await initializeSlimSchema(db)
      const service = new SqliteSlimStorage(db)
      db.pragma('journal_mode = WAL')
      return service
    } catch (error) {
      db.close()
      // Keep the reserved staging path for manual diagnosis rather than
      // risking a cleanup that races with another process.
      throw error
    }
  }

  async close(): Promise<void> {
    await this.executor.close()
  }
}
