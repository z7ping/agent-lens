import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgentLensApplication,
  coreServicesPlugin,
  discoverRegisteredSourceAssets,
  startRegisteredSourceCapture,
  syncRegisteredSourceHistory,
} from '@agent-lens/runtime-cordis'
import { claudeSourcePlugin } from '@agent-lens/source-claude'
import { codexSourcePlugin } from '@agent-lens/source-codex'
import { piSourcePlugin } from '@agent-lens/source-pi'
import { sqliteStoragePlugin } from '@agent-lens/storage-sqlite'
import {
  DEFAULT_AGENT_LENS_HTTP_PORT,
  httpSurfacePlugin,
} from '@agent-lens/surface-http'

const dbPath = process.env.AGENT_LENS_DB_PATH
  ?? join(homedir(), '.agent-lens', '1.0', 'agent-lens.db')
const configuredPort = process.env.AGENT_LENS_PORT
  ? Number(process.env.AGENT_LENS_PORT)
  : DEFAULT_AGENT_LENS_HTTP_PORT
const bundledWebRoot = fileURLToPath(new URL('./web/', import.meta.url))
const workspaceWebRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url))
const webRoot = process.env.AGENT_LENS_WEB_ROOT
  ?? (existsSync(fileURLToPath(new URL('./web/index.html', import.meta.url))) ? bundledWebRoot : workspaceWebRoot)

const app = new AgentLensApplication()
app.use(sqliteStoragePlugin, { path: dbPath })
app.useRuntime(coreServicesPlugin)
app.use(codexSourcePlugin)
app.use(claudeSourcePlugin)
app.use(piSourcePlugin)
app.use(httpSurfacePlugin, {
  port: configuredPort,
  staticDir: webRoot,
})

const runtimeController = new AbortController()
let syncPromise: ReturnType<typeof syncRegisteredSourceHistory> | null = null
let captureHandles: Awaited<ReturnType<typeof startRegisteredSourceCapture>> = []
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  runtimeController.abort()

  try {
    if (syncPromise) await syncPromise.catch(() => undefined)
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

process.once('SIGINT', () => void shutdown('SIGINT'))
process.once('SIGTERM', () => void shutdown('SIGTERM'))

try {
  await app.start()
  console.info(`[AgentLens] 1.0 runtime started (db: ${dbPath})`)
  console.info(`[AgentLens] Web/UI: http://127.0.0.1:${configuredPort} (root: ${webRoot})`)

  syncPromise = syncRegisteredSourceHistory(app.context, runtimeController.signal)
  const historyResults = await syncPromise
  for (const result of historyResults) {
    console.info(
      `[AgentLens] history synced: ${result.sourceId} records=${result.records} created=${result.observationsCreated} merged=${result.observationsMerged} unchanged=${result.observationsUnchanged}`,
    )
  }

  const assetResults = await discoverRegisteredSourceAssets(app.context, runtimeController.signal)
  for (const result of assetResults) {
    console.info(
      `[AgentLens] assets scanned: ${result.sourceId} assets=${result.assetsDiscovered} states=${result.statesRecorded}`,
    )
  }

  captureHandles = await startRegisteredSourceCapture(app.context, runtimeController.signal)
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
