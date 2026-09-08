import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defineAgentLensPlugin, type AgentLensContext } from '@agent-lens/runtime-cordis'
import { DataRuntimeClient } from './client.js'
import {
  createDataRuntimeStorage,
  type DataRuntimeService,
} from './storage-proxy.js'
import { logDataRuntimeFailure } from './diagnostics.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dataRuntime: DataRuntimeService
  }
}

export interface DataRuntimeStoragePluginConfig {
  path: string
}

const FOREGROUND_READER_COUNT = 2

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
    const readers = config.path === ':memory:'
      ? [writer]
      : Array.from({ length: FOREGROUND_READER_COUNT }, () => new DataRuntimeClient({ ...common, role: 'reader' }))
    const maintenanceReader = config.path === ':memory:'
      ? writer
      : new DataRuntimeClient({ ...common, role: 'reader' })
    const runtime = createDataRuntimeStorage(writer, readers, maintenanceReader)

    await writer.start().catch(error => {
      logDataRuntimeFailure('[AgentLens] Data Runtime writer unavailable at startup; control plane will run degraded', { error })
    })
    if (writer.state() === 'ready') {
      for (const [index, reader] of readers.entries()) {
        if (reader === writer) continue
        await reader.start().catch(error => {
          logDataRuntimeFailure(`[AgentLens] Data Runtime foreground reader ${index + 1} unavailable at startup`, { error })
        })
      }
      if (maintenanceReader !== writer) {
        await maintenanceReader.start().catch(error => {
          logDataRuntimeFailure('[AgentLens] Data Runtime maintenance reader unavailable at startup', { error })
        })
      }
    }
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
  },
  { inject: ['node'] },
)

export const dataRuntimeStoragePlugin = defineAgentLensPlugin(manifest, applyDataRuntimeStorage)
