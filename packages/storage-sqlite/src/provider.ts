import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  defineStorageProvider,
  type StorageProviderManifest,
} from '@agent-lens/core'
import { SqliteStorageService } from './storage'

export interface SqliteStorageProviderConfig {
  path: string
  readonly?: boolean
}

export const sqliteStorageManifest: StorageProviderManifest = {
  pluginId: '@agent-lens/storage-sqlite',
  pluginVersion: '1.0.0-alpha.5',
  apiVersion: '1.0',
  pluginType: 'storage',
  displayName: 'AgentLens SQLite Storage',
  providerId: 'sqlite',
  engine: 'sqlite',
  capabilities: [
    'repositories',
    'checkpoints',
    'transactions',
    'health',
    'diagnostics',
    'maintenance',
    'replication',
  ],
}

export const sqliteStorageProvider = defineStorageProvider<
  SqliteStorageProviderConfig,
  SqliteStorageService
>({
  manifest: sqliteStorageManifest,

  async create(config) {
    if (!config?.path) throw new Error('SQLite storage requires a database path')
    if (config.path !== ':memory:' && !config.readonly) {
      await mkdir(dirname(config.path), { recursive: true })
    }
    return new SqliteStorageService({
      path: config.path,
      ...(config.readonly === undefined ? {} : { readonly: config.readonly }),
    })
  },

  async initialize(storage) {
    if (!storage.db.readonly) await storage.migrate()
  },

  async dispose(storage) {
    await storage.close()
  },
})
