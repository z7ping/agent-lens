import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AgentLensApplication,
  coreServicesPlugin,
  discoverRegisteredSourceAssets,
  startRegisteredSourceCapture,
  syncRegisteredSourceHistory,
} from '@agent-lens/runtime-cordis'
import { codexSourcePlugin } from '@agent-lens/source-codex'
import { sqliteStoragePlugin } from '@agent-lens/storage-sqlite'

const dbPath = process.env.AGENT_LENS_DB_PATH
  ?? join(homedir(), '.agent-lens', '1.0', 'agent-lens.db')

const app = new AgentLensApplication()
app.use(sqliteStoragePlugin, { path: dbPath })
app.useRuntime(coreServicesPlugin)
app.use(codexSourcePlugin)

const runtimeController = new AbortController()
let syncPromise: ReturnType<typeof syncRegisteredSourceHistory> | null = null
let captureHandles: Awaited<ReturnType<typeof startRegisteredSourceCapture>> = []
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  runtimeController.abort()

  try {
    if (syncPromise) {
      await syncPromise.catch(() => undefined)
    }
    for (const handle of [...captureHandles].reverse()) {
      await handle.dispose().catch(() => undefined)
    }
    captureHandles = []
    await app.stop()
    console.info(`[AgentLens] daemon stopped (${signal})`)
    process.exitCode = 0
  } catch (error) {
    console.error('[AgentLens] daemon shutdown failed', error)
    process.exitCode = 1
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT')
})

process.once('SIGTERM', () => {
  void shutdown('SIGTERM')
})

try {
  await app.start()
  console.info(`[AgentLens] 1.0 runtime started (db: ${dbPath})`)

  syncPromise = syncRegisteredSourceHistory(app.context, runtimeController.signal)
  const historyResults = await syncPromise
  for (const result of historyResults) {
    console.info(
      `[AgentLens] history synced: ${result.sourceId} records=${result.records} created=${result.observationsCreated} merged=${result.observationsMerged} unchanged=${result.observationsUnchanged}`,
    )
  }

  const assetResults = await discoverRegisteredSourceAssets(
    app.context,
    runtimeController.signal,
  )
  for (const result of assetResults) {
    console.info(
      `[AgentLens] assets scanned: ${result.sourceId} assets=${result.assetsDiscovered} states=${result.statesRecorded}`,
    )
  }

  captureHandles = await startRegisteredSourceCapture(
    app.context,
    runtimeController.signal,
  )
  for (const handle of captureHandles) {
    console.info(`[AgentLens] runtime capture started: ${handle.sourceId}`)
  }
} catch (error) {
  runtimeController.abort()
  for (const handle of [...captureHandles].reverse()) {
    await handle.dispose().catch(() => undefined)
  }
  await app.stop().catch(() => undefined)
  console.error('[AgentLens] daemon startup failed', error)
  process.exitCode = 1
}
