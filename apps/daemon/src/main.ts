import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AgentLensApplication,
  coreServicesPlugin,
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

const syncController = new AbortController()
let syncPromise: ReturnType<typeof syncRegisteredSourceHistory> | null = null
let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  syncController.abort()

  try {
    if (syncPromise) {
      await syncPromise.catch(() => undefined)
    }
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

  syncPromise = syncRegisteredSourceHistory(app.context, syncController.signal)
  const results = await syncPromise
  for (const result of results) {
    console.info(
      `[AgentLens] history synced: ${result.sourceId} records=${result.records} created=${result.observationsCreated} merged=${result.observationsMerged} unchanged=${result.observationsUnchanged}`,
    )
  }
} catch (error) {
  console.error('[AgentLens] daemon startup/history sync failed', error)
  process.exitCode = 1
}
