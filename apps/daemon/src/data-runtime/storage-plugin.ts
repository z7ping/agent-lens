import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defineAgentLensPlugin, type AgentLensContext } from '@agent-lens/runtime-cordis'
import { DataRuntimeClient } from './client.js'
import {
  createDataRuntimeStorage,
  type DataRuntimeService,
} from './storage-proxy.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dataRuntime: DataRuntimeService
  }
}

export interface DataRuntimeStoragePluginConfig {
  path: string
}

const manifest = {
  pluginId: '@agent-lens/data-runtime-storage',
  pluginVersion: '1.0.0-alpha.3',
  apiVersion: '1.0',
  pluginType: 'storage',
  displayName: 'AgentLens Data Runtime Storage',
} as const

const applyDataRuntimeStorage = Object.assign(
  async (ctx: AgentLensContext, config: DataRuntimeStoragePluginConfig) => {
    if (!config?.path) throw new Error('Data Runtime storage requires a database path')
    if (config.path !== ':memory:') await mkdir(dirname(config.path), { recursive: true })

    const common = {
      dbPath: config.path,
      nodeId: ctx.node.identity.nodeId,
    }
    const writer = new DataRuntimeClient({ ...common, role: 'writer' })
    // SQLite :memory: is connection-local. Reuse the writer client in tests/dev
    // rather than creating a second empty database that cannot observe writes.
    const reader = config.path === ':memory:'
      ? writer
      : new DataRuntimeClient({ ...common, role: 'reader' })

    try {
      // Writer owns schema migration and is the only writable SQLite connection.
      await writer.start()
      // Reader opens only after writer migration completed, so it never races schema creation.
      if (reader !== writer) await reader.start()
      const runtime = createDataRuntimeStorage(writer, reader)
      runtime.dataRuntime.startRecovery()
      const unprovideDataRuntime = ctx.provide('dataRuntime', runtime.dataRuntime)
      const unprovideStorage = ctx.provide('storage', runtime.storage)
      const unprovideUnifiedRead = ctx.provide('unifiedRead', runtime.unifiedRead)

      return async () => {
        unprovideUnifiedRead()
        unprovideStorage()
        unprovideDataRuntime()
        await runtime.dataRuntime.shutdown()
      }
    } catch (error) {
      if (reader !== writer) await reader.shutdown().catch(() => undefined)
      await writer.shutdown().catch(() => undefined)
      throw error
    }
  },
  { inject: ['node'] },
)

export const dataRuntimeStoragePlugin = defineAgentLensPlugin(manifest, applyDataRuntimeStorage)
