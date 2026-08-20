import { homedir } from 'node:os'
import { join } from 'node:path'
import { AgentLensApplication } from '@agent-lens/runtime-cordis'
import { sqliteStoragePlugin } from '@agent-lens/storage-sqlite'

const dbPath = process.env.AGENT_LENS_DB_PATH
  ?? join(homedir(), '.agent-lens', '1.0', 'agent-lens.db')

const app = new AgentLensApplication()
app.use(sqliteStoragePlugin, { path: dbPath })

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  try {
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
} catch (error) {
  console.error('[AgentLens] daemon startup failed', error)
  process.exitCode = 1
}
