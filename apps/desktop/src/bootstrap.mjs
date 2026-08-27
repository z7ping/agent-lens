import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { app } from 'electron'

function fallbackBootLogPath() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'AgentLens', 'logs', 'desktop.log')
  }
  return join(homedir(), '.agent-lens', 'desktop.log')
}

function selectBootLogPath() {
  const candidates = [
    process.env.AGENT_LENS_DESKTOP_BOOT_LOG,
    process.env.AGENT_LENS_LOG_DIR?.trim()
      ? join(process.env.AGENT_LENS_LOG_DIR.trim(), 'desktop.log')
      : null,
    app.isPackaged ? join(dirname(process.execPath), 'logs', 'desktop.log') : null,
    fallbackBootLogPath(),
  ].filter((value, index, values) => value && values.indexOf(value) === index)

  for (const candidate of candidates) {
    try {
      mkdirSync(dirname(candidate), { recursive: true })
      appendFileSync(candidate, '', 'utf8')
      return candidate
    } catch {
      // Try the next writable location. Early startup must retain a fallback.
    }
  }
  return fallbackBootLogPath()
}

const bootLogPath = selectBootLogPath()

try {
  app.setName('AgentLens')
  mkdirSync(dirname(bootLogPath), { recursive: true })
  app.setPath('logs', dirname(bootLogPath))
} catch {
  // Product naming and log routing must not prevent early diagnostic logging.
}

function bootStage(stage) {
  try {
    mkdirSync(dirname(bootLogPath), { recursive: true })
    appendFileSync(bootLogPath, `${new Date().toISOString()} bootstrap ${stage} pid=${process.pid} argv=${JSON.stringify(process.argv)}\n`, 'utf8')
  } catch {
    // Diagnostic logging must never change desktop startup semantics.
  }
}

globalThis.__agentLensBootStage = bootStage

bootStage(`entered ready=${app.isReady()} packaged=${app.isPackaged} log=${bootLogPath}`)
for (const event of ['will-finish-launching', 'ready', 'browser-window-created', 'before-quit', 'will-quit', 'quit']) {
  app.on(event, () => bootStage(`event:${event}`))
}
app.on('render-process-gone', (_event, _webContents, details) => {
  bootStage(`render-process-gone:reason=${details.reason} exitCode=${details.exitCode}`)
})
app.on('child-process-gone', (_event, details) => {
  bootStage(`child-process-gone:type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name ?? ''}`)
})
process.on('uncaughtException', error => {
  bootStage(`uncaughtException:${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})
process.on('unhandledRejection', error => {
  bootStage(`unhandledRejection:${error instanceof Error ? error.stack ?? error.message : String(error)}`)
})

bootStage('before-external-links-import')
await import('./external-links.mjs')
bootStage('after-external-links-import')
await import('./main.mjs')
bootStage('after-main-import')
await import('./integration.mjs')
bootStage('after-integration-import')
