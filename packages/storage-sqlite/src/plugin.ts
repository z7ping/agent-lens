import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  defineAgentLensPlugin,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import { SqliteHubRemoteReadRepository } from './hub-remote-reader'
import {
  HubUnifiedLogicalSessionReader,
  HubUnifiedObservationReader,
} from './hub-unified-reader'
import { SqliteStorageService } from './storage'

export interface SqliteStoragePluginConfig {
  path: string
}

const manifest = {
  pluginId: '@agent-lens/storage-sqlite',
  pluginVersion: '1.0.0-alpha.1',
  apiVersion: '1.0',
  pluginType: 'storage',
  displayName: 'AgentLens SQLite Storage',
} as const

const applyStorage = Object.assign(
  async (
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
      const remote = new SqliteHubRemoteReadRepository(storage.executor)
      const logicalSessions = new HubUnifiedLogicalSessionReader(
        ctx.node.identity.nodeId,
        storage.repositories.sessions,
        storage.sessionSummaries,
        remote,
      )
      const observations = new HubUnifiedObservationReader(
        ctx.node.identity.nodeId,
        storage.repositories.observations,
        logicalSessions,
        remote,
      )
      const unprovideStorage = ctx.provide('storage', storage)
      const unprovideUnifiedRead = ctx.provide('unifiedRead', {
        logicalSessions,
        observations,
      })
      return () => {
        unprovideUnifiedRead()
        unprovideStorage()
        storage.close()
      }
    } catch (error) {
      storage.close()
      throw error
    }
  },
  { inject: ['node'] },
)

export const sqliteStoragePlugin = defineAgentLensPlugin(manifest, applyStorage)
