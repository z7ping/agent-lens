import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
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
const EXPECTED_PROTOCOL_VERSION = '1.0'
const MAX_RESTARTS_PER_MINUTE = 5
const DAEMON_HEALTH_TIMEOUT_MS = 900
const DAEMON_PROBE_ATTEMPTS = 3
const port = process.env.AGENT_LENS_PORT ? Number(process.env.AGENT_LENS_PORT) : DEFAULT_PORT
const daemonUrl = `http://127.0.0.1:${port}`
const startHidden = process.argv.includes('--hidden')

let mainWindow = null
let tray = null
let daemon = null
let daemonLog = null
let daemonRestartTimer = null
let daemonStableTimer = null
let unexpectedExitTimes = []
let stoppingDaemon = false
let quitting = false
let quitAfterDaemonStop = false
let quitStopPromise = null
let daemonOwnership = 'none'
let externalDaemonOwner = null

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

async function readDaemonHealth(timeoutMs = DAEMON_HEALTH_TIMEOUT_MS) {
  try {
    const response = await fetch(`${daemonUrl}/api/v1/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok && response.status !== 503) return null
    const health = await response.json()
    return health && typeof health === 'object' ? health : null
  } catch {
    return null
  }
}

function assertCompatibleDaemon(health) {
  if (health.protocolVersion === EXPECTED_PROTOCOL_VERSION) return
  throw new Error(`检测到不兼容的 AgentLens 运行时：Protocol ${String(health.protocolVersion ?? 'unknown')}，当前客户端要求 ${EXPECTED_PROTOCOL_VERSION}`)
}

async function probeExistingDaemon() {
  for (let attempt = 0; attempt < DAEMON_PROBE_ATTEMPTS; attempt += 1) {
    const health = await readDaemonHealth()
    if (health) return health
    if (attempt < DAEMON_PROBE_ATTEMPTS - 1) await sleep(120)
  }
  return null
}

async function daemonReady() {
  const health = await readDaemonHealth()
  if (!health) return false
  assertCompatibleDaemon(health)
  return true
}

function runtimeOwnerLabel(owner) {
  if (owner === 'desktop') return 'Windows 客户端'
  if (owner === 'service') return '后台服务'
  if (owner === 'cli') return '命令行'
  return '其他 AgentLens 进程'
}

async function waitForDaemon() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await daemonReady()) return true
    if (daemonOwnership === 'desktop' && (!daemon || daemon.exitCode !== null)) return false
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
  if (daemonOwnership !== 'desktop') return
  if (daemonStableTimer) clearTimeout(daemonStableTimer)
  daemonStableTimer = setTimeout(() => {
    unexpectedExitTimes = []
    daemonStableTimer = null
    writeDaemonLog(`--- daemon considered stable ${new Date().toISOString()} ---`)
  }, 30_000)
}

function scheduleDaemonRecovery(code, signal) {
  if (daemonOwnership === 'external' || quitting || stoppingDaemon || daemonRestartTimer) return

  const now = Date.now()
  unexpectedExitTimes = unexpectedExitTimes.filter(value => now - value < 60_000)
  unexpectedExitTimes.push(now)

  if (unexpectedExitTimes.length > MAX_RESTARTS_PER_MINUTE) {
    writeDaemonLog('--- daemon recovery stopped: too many unexpected exits in 60s ---')
    void dialog.showMessageBox({
      type: 'error',
      title: 'AgentLens 运行时反复退出',
      message: 'AgentLens 后台服务在一分钟内多次异常退出，已停止自动重启。',
      detail: `最后一次退出：退出码=${code}，信号=${signal ?? '无'}。请查看日志：${join(app.getPath('logs'), 'daemon.log')}`,
    })
    return
  }

  const delay = Math.min(1000 * (2 ** Math.max(0, unexpectedExitTimes.length - 1)), 8000)
  writeDaemonLog(`--- daemon unexpected exit; restart in ${delay}ms (attempt=${unexpectedExitTimes.length}) ---`)
  daemonRestartTimer = setTimeout(() => {
    daemonRestartTimer = null
    void (async () => {
      if (quitting || stoppingDaemon) return
      try {
        await startDaemon()
        if (await waitForDaemon()) {
          writeDaemonLog(`--- daemon recovered ${new Date().toISOString()} ---`)
          markDaemonStable()
          if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(daemonUrl)
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        writeDaemonLog(`--- daemon recovery aborted: ${detail} ---`)
        if (!quitting) {
          void dialog.showMessageBox({
            type: 'error',
            title: 'AgentLens 运行时恢复失败',
            message: '检测到无法安全复用的 AgentLens 运行时，已停止桌面端自动接管。',
            detail,
          })
        }
      }
    })()
  }, delay)
}

async function startDaemon() {
  if (daemonOwnership === 'desktop' && daemon && daemon.exitCode === null) return 'desktop'

  const existing = await probeExistingDaemon()
  if (existing) {
    assertCompatibleDaemon(existing)
    daemonOwnership = 'external'
    externalDaemonOwner = typeof existing.runtime?.owner === 'string' ? existing.runtime.owner : null
    await ensureDaemonLog()
    writeDaemonLog(`\n--- reuse existing AgentLens daemon ${new Date().toISOString()} owner=${externalDaemonOwner ?? 'unknown'} ---`)
    return 'external'
  }

  await ensureDaemonLog()
  writeDaemonLog(`\n--- AgentLens desktop daemon start ${new Date().toISOString()} ---`)

  const child = spawn(process.execPath, [appAsset('runtime', 'daemon.mjs')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_LENS_DAEMON_MODE: 'managed',
      AGENT_LENS_RUNTIME_OWNER: 'desktop',
      AGENT_LENS_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  daemon = child
  daemonOwnership = 'desktop'
  externalDaemonOwner = null
  writeDaemonLog(`--- daemon spawned pid=${child.pid ?? 'unknown'} desktopPid=${process.pid} ---`)
  child.stdout?.pipe(daemonLog, { end: false })
  child.stderr?.pipe(daemonLog, { end: false })
  child.once('exit', (code, signal) => {
    const ownedByDesktop = daemonOwnership === 'desktop' && daemon === child
    writeDaemonLog(`--- daemon exited code=${code} signal=${signal ?? 'none'} expected=${quitting || stoppingDaemon} ---`)
    if (daemon === child) daemon = null
    if (ownedByDesktop) daemonOwnership = 'none'
    if (!quitting && !stoppingDaemon && ownedByDesktop) scheduleDaemonRecovery(code, signal)
  })
  return 'desktop'
}

async function stopDaemon() {
  clearRecoveryTimers()
  if (daemonOwnership === 'external') {
    writeDaemonLog(`--- leaving external daemon running owner=${externalDaemonOwner ?? 'unknown'} ---`)
    return
  }

  const current = daemon
  daemon = null
  daemonOwnership = 'none'
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
      await Promise.race([
        new Promise(resolve => current.once('exit', resolve)),
        sleep(500),
      ])
    }
  } finally {
    stoppingDaemon = false
  }
}

async function restartDaemon() {
  if (daemonOwnership === 'external') {
    const existing = await probeExistingDaemon()
    if (existing) {
      assertCompatibleDaemon(existing)
      const owner = typeof existing.runtime?.owner === 'string' ? existing.runtime.owner : externalDaemonOwner
      await dialog.showMessageBox({
        type: 'info',
        title: '后台服务由其他方式管理',
        message: `当前 AgentLens 后台服务由${runtimeOwnerLabel(owner)}管理。`,
        detail: '桌面客户端正在复用该运行时，不会擅自停止或重启它。请使用对应的命令行或后台服务管理入口进行重启。',
      })
      return
    }
    daemonOwnership = 'none'
    externalDaemonOwner = null
  }

  await stopDaemon()
  unexpectedExitTimes = []
  await startDaemon()
  if (await waitForDaemon()) {
    markDaemonStable()
    if (mainWindow && !mainWindow.isDestroyed()) await mainWindow.loadURL(daemonUrl)
  }
}

function canManageLoginAutostart() {
  return process.platform === 'win32' && app.isPackaged
}

function loginAutostartQueryOptions() {
  return {
    path: process.execPath,
    args: ['--hidden'],
  }
}

function loginAutostartOptions(openAtLogin) {
  return {
    ...loginAutostartQueryOptions(),
    openAtLogin,
  }
}

function isLoginAutostartEnabled() {
  if (!canManageLoginAutostart()) return false
  try {
    return app.getLoginItemSettings(loginAutostartQueryOptions()).openAtLogin
  } catch {
    return false
  }
}

function setLoginAutostart(enabled) {
  if (!canManageLoginAutostart()) return false
  try {
    app.setLoginItemSettings(loginAutostartOptions(enabled))
    return isLoginAutostartEnabled()
  } catch {
    return false
  }
}

async function ensureInitialLoginAutostart() {
  if (!canManageLoginAutostart()) return
  const marker = join(app.getPath('userData'), 'login-autostart-initialized')
  if (existsSync(marker)) return
  const enabled = setLoginAutostart(true)
  if (!enabled) {
    await ensureDaemonLog()
    writeDaemonLog('--- initial login autostart registration was not confirmed; will retry next launch ---')
    return
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(marker, 'initialized\n', 'utf8')
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
  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow?.show()
  })
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
  const template = [
    { label: '打开 AgentLens', click: showWindow },
    { label: '重启运行时', click: () => void restartDaemon() },
    ...(canManageLoginAutostart() ? [
      {
        label: '登录 Windows 后自动运行',
        type: 'checkbox',
        checked: isLoginAutostartEnabled(),
        click: item => {
          const requested = item.checked
          const actual = setLoginAutostart(requested)
          item.checked = actual
          if (actual !== requested) {
            void dialog.showMessageBox({
              type: 'warning',
              title: '登录自启设置未生效',
              message: requested ? 'Windows 没有确认启用 AgentLens 登录自启。' : 'Windows 没有确认关闭 AgentLens 登录自启。',
              detail: '托盘状态已恢复为系统实际状态。请检查当前用户的启动应用权限后重试。',
            })
          }
        },
      },
    ] : []),
    { label: '打开数据目录', click: () => void shell.openPath(join(homedir(), '.agent-lens', '1.0')) },
    { label: '打开日志目录', click: () => void shell.openPath(app.getPath('logs')) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
  tray.on('double-click', showWindow)
}

const singleInstance = app.requestSingleInstanceLock()
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

  await app.whenReady()
  app.setAppUserModelId('dev.z7ping.agentlens')
  await ensureInitialLoginAutostart()
  createWindow()
  createTray()

  try {
    await startDaemon()
    if (await waitForDaemon()) {
      markDaemonStable()
      await mainWindow.loadURL(daemonUrl)
    } else {
      await dialog.showMessageBox({
        type: 'error',
        title: 'AgentLens 运行时启动失败',
        message: 'AgentLens 后台服务未能正常启动。',
        detail: `请查看日志：${join(app.getPath('logs'), 'daemon.log')}`,
      })
      app.quit()
    }
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'AgentLens 运行时不兼容',
      message: '检测到已经运行的 AgentLens，但当前客户端无法安全复用。',
      detail: error instanceof Error ? error.message : String(error),
    })
    app.quit()
  }
}
