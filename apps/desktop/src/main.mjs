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
const port = process.env.AGENT_LENS_PORT ? Number(process.env.AGENT_LENS_PORT) : DEFAULT_PORT
const daemonUrl = `http://127.0.0.1:${port}`

let mainWindow = null
let tray = null
let daemon = null
let daemonLog = null
let quitting = false

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function appAsset(...parts) {
  return join(app.getAppPath(), ...parts)
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

async function startDaemon() {
  if (daemon && daemon.exitCode === null) return
  const logDir = app.getPath('logs')
  await mkdir(logDir, { recursive: true })
  daemonLog = createWriteStream(join(logDir, 'daemon.log'), { flags: 'a' })
  daemonLog.write(`\n--- AgentLens desktop start ${new Date().toISOString()} ---\n`)

  daemon = spawn(process.execPath, [appAsset('runtime', 'daemon.mjs')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_LENS_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  daemon.stdout?.pipe(daemonLog, { end: false })
  daemon.stderr?.pipe(daemonLog, { end: false })
  daemon.once('exit', (code, signal) => {
    daemonLog?.write(`\n--- daemon exited code=${code} signal=${signal} ---\n`)
    daemon = null
  })
}

async function stopDaemon() {
  const current = daemon
  daemon = null
  if (!current || current.exitCode !== null) return
  current.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => current.once('exit', resolve)),
    sleep(2500),
  ])
  if (current.exitCode === null) current.kill('SIGKILL')
}

async function restartDaemon() {
  await stopDaemon()
  await startDaemon()
  if (await waitForDaemon()) mainWindow?.loadURL(daemonUrl)
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
    { label: 'Open AgentLens', click: showWindow },
    { label: 'Restart runtime', click: () => void restartDaemon() },
    { label: 'Open data folder', click: () => void shell.openPath(join(homedir(), '.agent-lens', '1.0')) },
    { label: 'Open logs', click: () => void shell.openPath(app.getPath('logs')) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit() } },
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
    void stopDaemon()
  })
  app.on('window-all-closed', event => event?.preventDefault?.())

  await app.whenReady()
  app.setAppUserModelId('dev.z7ping.agentlens')
  createWindow()
  createTray()

  await startDaemon()
  if (await waitForDaemon()) {
    await mainWindow.loadURL(daemonUrl)
  } else {
    await dialog.showMessageBox({
      type: 'error',
      title: 'AgentLens runtime failed to start',
      message: 'The AgentLens daemon did not become ready.',
      detail: `See ${join(app.getPath('logs'), 'daemon.log')} for details.`,
    })
    quitting = true
    app.quit()
  }
}
