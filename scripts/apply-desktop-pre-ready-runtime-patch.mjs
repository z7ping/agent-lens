import { readFile, writeFile } from 'node:fs/promises'

const path = new URL('../apps/desktop/src/main.mjs', import.meta.url)
const source = await readFile(path, 'utf8')
const marker = 'const singleInstance = app.requestSingleInstanceLock()'
const index = source.indexOf(marker)
if (index < 0) throw new Error('找不到桌面启动编排入口')

const tail = `const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('before-quit', event => {
    if (quitAfterDaemonStop) return
    event.preventDefault()
    quitting = true
    clearRecoveryTimers()
    if (!quitStopPromise) {
      quitStopPromise = stopDaemon().finally(() => {
        daemonLog?.end()
        quitAfterDaemonStop = true
        app.quit()
      })
    }
  })
  app.on('window-all-closed', event => event?.preventDefault?.())

  // Runtime ownership is independent from Chromium/UI readiness. Start or reuse the
  // single Daemon as soon as the process owns the desktop instance lock, so a slow
  // or unavailable GUI session cannot leave AgentLens silently doing nothing.
  let runtimeReady = false
  let startupError = null
  try {
    await ensureDaemonLog()
    writeDaemonLog('\\n--- AgentLens desktop start ' + new Date().toISOString() + ' packaged=' + app.isPackaged + ' pid=' + process.pid + ' ---')
    await startDaemon()
    runtimeReady = await waitForDaemon()
    if (!runtimeReady) {
      throw new Error('AgentLens 后台服务未能正常启动。请查看日志：' + join(app.getPath('logs'), 'daemon.log'))
    }
    markDaemonStable()
  } catch (error) {
    startupError = error
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    writeDaemonLog('--- desktop runtime startup failed: ' + detail + ' ---')
  }

  await app.whenReady()
  app.setAppUserModelId('dev.z7ping.agentlens')

  if (startupError || !runtimeReady) {
    const detail = startupError instanceof Error ? startupError.stack ?? startupError.message : String(startupError ?? '运行时未就绪')
    await dialog.showMessageBox({
      type: 'error',
      title: 'AgentLens 启动失败',
      message: 'AgentLens Windows 客户端未能正常启动。',
      detail: detail + '\\n\\n日志：' + join(app.getPath('logs'), 'daemon.log'),
    })
    app.quit()
  } else {
    createWindow()

    try {
      createTray()
    } catch (error) {
      tray = null
      writeDaemonLog('--- tray creation failed: ' + (error instanceof Error ? error.stack ?? error.message : String(error)) + ' ---')
    }

    try {
      await ensureInitialLoginAutostart()
    } catch (error) {
      writeDaemonLog('--- initial login autostart failed: ' + (error instanceof Error ? error.message : String(error)) + ' ---')
    }

    await mainWindow.loadURL(daemonUrl)
  }
}
`

await writeFile(path, source.slice(0, index) + tail, 'utf8')
console.log('[AgentLens] desktop startup orchestration patched')
