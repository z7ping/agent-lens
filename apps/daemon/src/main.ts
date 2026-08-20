import { AgentLensApplication } from '@agent-lens/runtime-cordis'

const app = new AgentLensApplication()
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
  console.info('[AgentLens] 1.0 Cordis runtime started')
} catch (error) {
  console.error('[AgentLens] daemon startup failed', error)
  process.exitCode = 1
}
