import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  defineAgentLensPlugin,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import { SqliteStorageService } from './storage'

export interface SqliteStoragePluginConfig {
  path: string
}

const manifest = {
  pluginId: '@agent-lens/storage-sqlite',
  pluginVersion: '1.0.0-alpha.0',
  apiVersion: '1.0',
  pluginType: 'storage',
  displayName: 'AgentLens SQLite Storage',
} as const

const applyStorage = async (
  ctx: AgentLensContext,
  config: SqliteStoragePluginConfig,
) => {
  if (!config?.path) {
    throw new Error('SQLite storage requires a database path')
  }

  if (config.path !== ':memory:') {
    await mkdir(dirname(config.path), { recursive: true })
  }

  const storage = new SqliteStorageService({ path: config.path })
  try {
    await storage.migrate()
    const unprovide = ctx.provide('storage', storage)
    return () => {
      unprovide()
      storage.close()
    }
  } catch (error) {
    storage.close()
    throw error
  }
}

export const sqliteStoragePlugin = defineAgentLensPlugin(manifest, applyStorage)
