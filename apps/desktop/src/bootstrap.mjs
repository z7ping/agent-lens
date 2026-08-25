import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { app } from 'electron'

function bootStage(stage) {
  const target = process.env.AGENT_LENS_DESKTOP_BOOT_LOG
  if (!target) return
  try {
    mkdirSync(dirname(target), { recursive: true })
    appendFileSync(target, `${new Date().toISOString()} bootstrap ${stage} pid=${process.pid} argv=${JSON.stringify(process.argv)}\n`, 'utf8')
  } catch {
    // Diagnostic logging must never change desktop startup semantics.
  }
}

bootStage(`entered ready=${app.isReady()}`)
for (const event of ['will-finish-launching', 'ready', 'browser-window-created', 'before-quit', 'will-quit', 'quit']) {
  app.on(event, () => bootStage(`event:${event}`))
}
process.on('uncaughtException', error => {
  bootStage(`uncaughtException:${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})
process.on('unhandledRejection', error => {
  bootStage(`unhandledRejection:${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})

bootStage('before-main-import')
await import('./main.mjs')
bootStage('after-main-import')
await import('./integration.mjs')
bootStage('after-integration-import')
