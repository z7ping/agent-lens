import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  nativeImage,
  shell,
} from 'electron'

const DEFAULT_PORT = 56789
const MAX_RESTARTS_PER_MINUTE = 5
const port = process.env.AGENT_LENS_PORT ? Number(process.env.AGENT_LENS_PORT) : DEFAULT_PORT
const daemonUrl = `http://127.0.0.1:${port}`

let mainWindow = null
let tray = null
let daemon = null
let daemonLog = null
let daemonRestartTimer = null
let daemonStableTimer = null
let unexpectedExitTimes = []
let stoppingDaemon = false
let quitting = false

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function appAsset(...parts) {
  return join(app.getAppPath(), ...parts)
}

async function ensureDaemonLog() {
  if (daemonLog && !daemonLog.destroyed) return
  const logDir = app.getPath('logs')
  await mkdir(logDir, { recursive: true })
  daemonLog = createWriteStream(join(logDir, 'daemon.log'), { flags: 'a' })
}

function writeDaemonLog(message) {
  daemonLog?.write(`${message}\n`)
}

async function daemonReady() {
  try {
    const response = await fetch(`${daemonUrl}/api/v1/health`, { signal: AbortSignal.timeout(500) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForDaemon() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await daemonReady()) return true
    if (!daemon || daemon.exitCode !== null) return false
    await sleep(150)
  }
  return false
}

function clearRecoveryTimers() {
  if (daemonRestartTimer) clearTimeout(daemonRestartTimer)
  if (daemonStableTimer) clearTimeout(daemonStableTimer)
  daemonRestartTimer = null
  daemonStableTimer = null
}

function markDaemonStable() {
  if (daemonStableTimer) clearTimeout(daemonStableTimer)
  daemonStableTimer = setTimeout(() => {
    unexpectedExitTimes = []
    daemonStableTimer = null
    writeDaemonLog(`--- daemon considered stable ${new Date().toISOString()} ---`)
  }, 30_000)
}

function scheduleDaemonRecovery(code, signal) {
  if (quitting || stoppingDaemon || daemonRestartTimer) return

  const now = Date.now()
  unexpectedExitTimes = unexpectedExitTimes.filter(value => now - value < 60_000)
  unexpectedExitTimes.push(now)

  if (unexpectedExitTimes.length > MAX_RESTARTS_PER_MINUTE) {
    writeDaemonLog('--- daemon recovery stopped: too many unexpected exits in 60s ---')
    void dialog.showMessageBox({
      type: 'error',
      title: 'AgentLens 运行时反复退出',
      message: 'AgentLens Daemon 在一分钟内多次异常退出，已停止自动重启。',
      detail: `最后一次退出：code=${code} signal=${signal ?? 'none'}。请查看日志：${join(app.getPath('logs'), 'daemon.log')}`,
    })
    return
  }

  const delay = Math.min(1000 * (2 ** Math.max(0, unexpectedExitTimes.length - 1)), 8000)
  writeDaemonLog(`--- daemon unexpected exit; restart in ${delay}ms (attempt=${unexpectedExitTimes.length}) ---`)
  daemonRestartTimer = setTimeout(() => {
    daemonRestartTimer = null
    void (async () => {
      if (quitting || stoppingDaemon) return
      await startDaemon()
      if (await waitForDaemon()) {
        writeDaemonLog(`--- daemon recovered ${new Date().toISOString()} ---`)
        markDaemonStable()
        if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(daemonUrl)
      }
    })()
  }, delay)
}

async function startDaemon() {
  if (daemon && daemon.exitCode === null) return
  await ensureDaemonLog()
  writeDaemonLog(`\n--- AgentLens desktop daemon start ${new Date().toISOString()} ---`)

  const child = spawn(process.execPath, [appAsset('runtime', 'daemon.mjs')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_LENS_DAEMON_MODE: 'managed',
      AGENT_LENS_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  daemon = child
  writeDaemonLog(`--- daemon spawned pid=${child.pid ?? 'unknown'} desktopPid=${process.pid} ---`)
  child.stdout?.pipe(daemonLog, { end: false })
  child.stderr?.pipe(daemonLog, { end: false })
  child.once('exit', (code, signal) => {
    writeDaemonLog(`--- daemon exited code=${code} signal=${signal ?? 'none'} expected=${quitting || stoppingDaemon} ---`)
    if (daemon === child) daemon = null
    if (!quitting && !stoppingDaemon) scheduleDaemonRecovery(code, signal)
  })
}

async function stopDaemon() {
  clearRecoveryTimers()
  const current = daemon
  daemon = null
  if (!current || current.exitCode !== null) return

  stoppingDaemon = true
  try {
    writeDaemonLog(`--- stopping daemon pid=${current.pid ?? 'unknown'} with SIGTERM ---`)
    current.kill('SIGTERM')
    await Promise.race([
      new Promise(resolve => current.once('exit', resolve)),
      sleep(2500),
    ])
    if (current.exitCode === null) {
      writeDaemonLog(`--- daemon pid=${current.pid ?? 'unknown'} did not stop in time; sending SIGKILL ---`)
      current.kill('SIGKILL')
    }
  } finally {
    stoppingDaemon = false
  }
}

async function restartDaemon() {
  await stopDaemon()
  unexpectedExitTimes = []
  await startDaemon()
  if (await waitForDaemon()) {
    markDaemonStable()
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(daemonUrl)
  }
}

function showWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0d10',
    icon: appAsset('assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  mainWindow.removeMenu()
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', event => {
    if (quitting) return
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

function createTray() {
  const image = nativeImage.createFromPath(appAsset('assets', 'icon.png')).resize({ width: 16, height: 16 })
  tray = new Tray(image)
  tray.setToolTip('AgentLens')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 AgentLens', click: showWindow },
    { label: '重启运行时', click: () => void restartDaemon() },
    { label: '打开数据目录', click: () => void shell.openPath(join(homedir(), '.agent-lens', '1.0')) },
    { label: '打开日志目录', click: () => void shell.openPath(app.getPath('logs')) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } },
  ]))
  tray.on('double-click', showWindow)
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('before-quit', () => {
    quitting = true
    clearRecoveryTimers()
    void stopDaemon()
  })
  app.on('window-all-closed', event => event?.preventDefault?.())

  await app.whenReady()
  app.setAppUserModelId('dev.z7ping.agentlens')
  createWindow()
  createTray()

  await startDaemon()
  if (await waitForDaemon()) {
    markDaemonStable()
    await mainWindow.loadURL(daemonUrl)
  } else {
    await dialog.showMessageBox({
      type: 'error',
      title: 'AgentLens 运行时启动失败',
      message: 'AgentLens Daemon 未能正常启动。',
      detail: `请查看日志：${join(app.getPath('logs'), 'daemon.log')}`,
    })
    quitting = true
    app.quit()
  }
}
