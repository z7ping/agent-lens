import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentLensPluginManifest } from '@agent-lens/core'
import { SqliteStorageService } from './storage'

export interface SqliteStoragePluginConfig {
  path: string
}

export const sqliteStorageManifest = {
  pluginId: '@agent-lens/storage-sqlite',
  pluginVersion: '1.0.0-alpha.0',
  apiVersion: '1.0',
  pluginType: 'storage',
  displayName: 'AgentLens SQLite Storage',
} as const satisfies AgentLensPluginManifest

export async function createSqliteStorage(
  config: SqliteStoragePluginConfig,
): Promise<{
  storage: SqliteStorageService
  dispose(): void
}> {
  if (!config?.path) {
    throw new Error('SQLite storage requires a database path')
  }

  if (config.path !== ':memory:') {
    await mkdir(dirname(config.path), { recursive: true })
  }

  const storage = new SqliteStorageService({ path: config.path })
  try {
    await storage.migrate()
    return {
      storage,
      dispose() {
        storage.close()
      },
    }
  } catch (error) {
    storage.close()
    throw error
  }
}
