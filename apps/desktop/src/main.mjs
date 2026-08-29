import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  shell,
} from 'electron'
import { createLoginAutostartController } from './login-autostart.mjs'
import { migrateLegacyWindowsRuntime } from './legacy-windows-migration.mjs'

const DEFAULT_PORT = 56789
const EXPECTED_PROTOCOL_VERSION = '1.0'
const MAX_RESTARTS_PER_MINUTE = 5
const DAEMON_FAST_HEALTH_TIMEOUT_MS = 250
const DAEMON_HEALTH_TIMEOUT_MS = 900
const DAEMON_BUSY_PROBE_ATTEMPTS = 3
const DAEMON_PORT_TIMEOUT_MS = 180
const DAEMON_STARTUP_HEALTH_TIMEOUT_MS = 10_000
const DAEMON_STARTUP_TIMEOUT_MS = 10 * 60_000
const DAEMON_STARTUP_RETRY_DELAY_MS = 500
const port = process.env.AGENT_LENS_PORT ? Number(process.env.AGENT_LENS_PORT) : DEFAULT_PORT
const daemonUrl = `http://127.0.0.1:${port}`
const desktopSmokeMode = process.env.AGENT_LENS_DESKTOP_SMOKE === '1'
const loginAutostart = createLoginAutostartController({ app })
const startupPage = `data:text/html;charset=UTF-8,${encodeURIComponent(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>AgentLens · 智能体透镜</title>
<style>
  html,body{height:100%;margin:0;background:#0b0d10;color:#f1f4f8;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
  body{display:grid;place-items:center}
  main{display:flex;align-items:center;gap:14px;padding:24px 28px;border:1px solid #252b34;border-radius:14px;background:#11151b}
  strong{display:block;font-size:18px;letter-spacing:.01em}
  span{display:block;margin-top:4px;color:#9da8b7;font-size:13px}
  i{width:10px;height:10px;border-radius:50%;background:#8eb8ff;box-shadow:0 0 0 5px rgba(142,184,255,.12)}
</style>
</head>
<body><main><i></i><div><strong>AgentLens · 智能体透镜</strong><span>正在启动本地运行时；首次启动或数据较多时可能需要几分钟…</span></div></main></body>
</html>`)} `

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
let pendingShowRequest = false

function bootStage(stage) {
  globalThis.__agentLensBootStage?.(`main:${stage}`)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function appAsset(...parts) {
  return join(app.getAppPath(), ...parts)
}

function unpackedAsset(...parts) {
  if (app.isPackaged) return join(process.resourcesPath, 'app.asar.unpacked', ...parts)
  return appAsset(...parts)
}

function desktopIconPath() {
  const windowIcon = unpackedAsset('assets', 'icon-window.png')
  if (existsSync(windowIcon)) return windowIcon
  return unpackedAsset('assets', 'icon-win.png')
}

async function trayIcon() {
  if (process.platform === 'win32') return unpackedAsset('assets', 'tray.ico')
  return app.getFileIcon(process.execPath, { size: 'small' })
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

function isDaemonPortOpen(timeoutMs = DAEMON_PORT_TIMEOUT_MS) {
  return new Promise(resolve => {
    let settled = false
    const socket = connect({ host: '127.0.0.1', port })
    const done = value => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function probeExistingDaemon() {
  const fastHealth = await readDaemonHealth(DAEMON_FAST_HEALTH_TIMEOUT_MS)
  if (fastHealth) return fastHealth

  // 冷启动时默认端口通常会立即拒绝连接，此时直接拉起自己的 Daemon，
  // 不再为了“确认不存在”连续等待多个 Health 超时。
  // 如果端口已经被占用，则继续使用较长 Health 探测，避免把一个正在
  // 启动或暂时繁忙的现有 AgentLens 误判成“没有运行时”。
  if (!await isDaemonPortOpen()) return null

  for (let attempt = 0; attempt < DAEMON_BUSY_PROBE_ATTEMPTS; attempt += 1) {
    const health = await readDaemonHealth()
    if (health) return health
    if (attempt < DAEMON_BUSY_PROBE_ATTEMPTS - 1) await sleep(120)
  }

  throw new Error(`端口 ${port} 已被占用，但没有得到兼容的 AgentLens Health 响应。为避免启动第二个默认运行时，桌面端不会继续接管。`)
}

async function daemonReady(timeoutMs = DAEMON_HEALTH_TIMEOUT_MS) {
  const health = await readDaemonHealth(timeoutMs)
  if (!health) return false
  assertCompatibleDaemon(health)
  return true
}

function runtimeOwnerLabel(owner) {
  if (owner === 'desktop') return '桌面端'
  if (owner === 'service') return '后台服务'
  if (owner === 'cli') return '命令行'
  return '其他 AgentLens 进程'
}

async function waitForDaemon() {
  const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS
  let nextProgressLogAt = Date.now() + 30_000
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (await daemonReady(Math.min(DAEMON_STARTUP_HEALTH_TIMEOUT_MS, remaining))) return true
    if (daemonOwnership === 'desktop' && (!daemon || daemon.exitCode !== null)) return false
    if (Date.now() >= nextProgressLogAt) {
      writeDaemonLog(`--- waiting for Health; daemon is still running ${new Date().toISOString()} ---`)
      nextProgressLogAt = Date.now() + 30_000
    }
    await sleep(Math.min(DAEMON_STARTUP_RETRY_DELAY_MS, Math.max(0, deadline - Date.now())))
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

  const daemonEntry = unpackedAsset('runtime', 'daemon.mjs')
  writeDaemonLog(`--- daemon entry ${daemonEntry} ---`)
  const child = spawn(process.execPath, [daemonEntry], {
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
        detail: '桌面端正在复用该运行时，不会擅自停止或重启它。请使用对应的命令行或后台服务管理入口进行重启。',
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
  return !desktopSmokeMode && loginAutostart.isSupported()
}

function isLoginAutostartEnabled() {
  return loginAutostart.isEnabled()
}

function setLoginAutostart(enabled) {
  return loginAutostart.setEnabled(enabled)
}

async function ensureInitialLoginAutostart() {
  if (!canManageLoginAutostart()) return
  const marker = join(app.getPath('userData'), 'login-autostart-initialized')
  if (existsSync(marker)) {
    if (isLoginAutostartEnabled() && !loginAutostart.refreshRegistrationIfEnabled()) {
      await ensureDaemonLog()
      writeDaemonLog('--- existing login autostart registration could not be refreshed ---')
    }
    return
  }
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
  pendingShowRequest = true
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow() {
  const startHidden = loginAutostart.shouldStartHidden(process.argv) && !pendingShowRequest
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    // 普通双击和安装完成后的首次启动必须立刻显示启动反馈；只有明确
    // 带 --hidden 的登录自启才从托盘静默启动。
    show: !startHidden,
    backgroundColor: '#0b0d10',
    icon: desktopIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  mainWindow.removeMenu()
  mainWindow.on('close', event => {
    if (quitting) return
    event.preventDefault()
    if (!tray) {
      app.quit()
      return
    }
    mainWindow?.hide()
  })
  mainWindow.on('closed', () => { mainWindow = null })
  void mainWindow.loadURL(startupPage).catch(error => {
    writeDaemonLog(`--- startup page failed: ${error instanceof Error ? error.message : String(error)} ---`)
  })
}

async function createTray() {
  tray = new Tray(await trayIcon())
  tray.setToolTip('AgentLens · 智能体透镜')
  const template = [
    { label: '打开 AgentLens', click: showWindow },
    { label: '重启运行时', click: () => void restartDaemon() },
    ...(canManageLoginAutostart() ? [
      {
        label: `登录 ${loginAutostart.platformLabel()} 后自动运行`,
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
              message: requested ? '系统没有确认启用 AgentLens 登录自启。' : '系统没有确认关闭 AgentLens 登录自启。',
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
bootStage(`single-instance-lock=${singleInstance}`)
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (!argv.includes('--hidden')) showWindow()
  })
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

  // 动态导入的主模块必须立即完成求值。这里不能顶层 await app.whenReady()：
  // Electron 要等入口模块返回事件循环后才会发出 ready，否则打包应用会无窗口卡住。
  bootStage('startup-continuation-scheduled')
  void (async () => {
    bootStage('before-when-ready')
    await app.whenReady()
    bootStage('after-when-ready')
    if (process.platform === 'win32') app.setAppUserModelId('dev.z7ping.agentlens')
    await ensureDaemonLog()
    writeDaemonLog('\n--- AgentLens desktop ready ' + new Date().toISOString() + ' packaged=' + app.isPackaged + ' pid=' + process.pid + ' ---')

    createWindow()
    writeDaemonLog('--- startup window created ---')

    try {
      await createTray()
      writeDaemonLog('--- tray created ---')
    } catch (error) {
      tray = null
      writeDaemonLog('--- tray creation failed: ' + (error instanceof Error ? error.stack ?? error.message : String(error)) + ' ---')
    }

    try {
      const migration = await migrateLegacyWindowsRuntime({
        port,
        logger: writeDaemonLog,
      })
      if (migration.changed) {
        writeDaemonLog(`--- legacy runtime migration applied version=${migration.legacyVersion ?? 'unknown'} stopped=${migration.stoppedPids?.join(',') || 'none'} startupRemoved=${migration.removedStartup === true} ---`)
      }
    } catch (error) {
      const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error)
      const detail = error instanceof Error ? error.message : String(error)
      writeDaemonLog('--- legacy Windows migration failed: ' + diagnostic + ' ---')
      await dialog.showMessageBox({
        type: 'error',
        title: 'AgentLens 升级迁移失败',
        message: '检测到旧版 AgentLens 运行时，但无法安全完成 0.x → 1.x 接管。',
        detail: detail + '\n\n日志：' + join(app.getPath('logs'), 'daemon.log'),
      })
      app.quit()
      return
    }

    try {
      await ensureInitialLoginAutostart()
    } catch (error) {
      writeDaemonLog('--- initial login autostart failed: ' + (error instanceof Error ? error.message : String(error)) + ' ---')
    }

    try {
      writeDaemonLog('\n--- AgentLens desktop start ' + new Date().toISOString() + ' packaged=' + app.isPackaged + ' pid=' + process.pid + ' ---')
      await startDaemon()
      if (!await waitForDaemon()) {
        const state = daemonOwnership === 'desktop' && daemon && daemon.exitCode === null
          ? '后台服务仍在运行，但在 10 分钟内没有完成 Health 响应。'
          : '后台服务已在 Health 就绪前退出。'
        throw new Error(`${state} 请查看日志：${join(app.getPath('logs'), 'daemon.log')}`)
      }
      markDaemonStable()
      await mainWindow.loadURL(daemonUrl)
    } catch (error) {
      const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error)
      const detail = error instanceof Error ? error.message : String(error)
      writeDaemonLog('--- desktop runtime startup failed: ' + diagnostic + ' ---')
      await dialog.showMessageBox({
        type: 'error',
        title: 'AgentLens 启动失败',
        message: 'AgentLens 桌面端未能正常启动。',
        detail: detail + '\n\n日志：' + join(app.getPath('logs'), 'daemon.log'),
      })
      app.quit()
    }
  })().catch(async error => {
    const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error)
    const detail = error instanceof Error ? error.message : String(error)
    writeDaemonLog('--- desktop shell startup failed: ' + diagnostic + ' ---')
    await app.whenReady()
    await dialog.showMessageBox({
      type: 'error',
      title: 'AgentLens 启动失败',
      message: 'AgentLens 桌面窗口未能正常创建。',
      detail,
    })
    app.quit()
  })
}
