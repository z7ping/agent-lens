import {
  defineAgentLensPlugin,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import { SqliteHubRemoteReadRepository } from './hub-remote-reader'
import {
  HubUnifiedLogicalSessionReader,
  HubUnifiedObservationReader,
} from './hub-unified-reader'
import { sqliteStorageProvider, type SqliteStorageProviderConfig } from './provider'

export type SqliteStoragePluginConfig = SqliteStorageProviderConfig

const applyStorage = Object.assign(
  async (
    ctx: AgentLensContext,
    config: SqliteStoragePluginConfig,
  ) => {
    const storage = await sqliteStorageProvider.create(config)
    try {
      await sqliteStorageProvider.initialize?.(storage, config)
      const remote = new SqliteHubRemoteReadRepository(storage.executor)
      const logicalSessions = new HubUnifiedLogicalSessionReader(
        ctx.node.identity.nodeId,
        storage.repositories.sessions,
        remote,
        storage.sessionSummaries,
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
      return async () => {
        unprovideUnifiedRead()
        unprovideStorage()
        await sqliteStorageProvider.dispose(storage)
      }
    } catch (error) {
      await sqliteStorageProvider.dispose(storage)
      throw error
    }
  },
  { inject: ['node'] },
)

export const sqliteStoragePlugin = defineAgentLensPlugin(sqliteStorageProvider.manifest, applyStorage)
