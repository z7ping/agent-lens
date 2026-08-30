import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { app, dialog, Notification, shell } from 'electron'
import {
  fetchAvailableUpdate,
  shouldCheckForUpdate,
  shouldNotifyUpdate,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_STARTUP_DELAY_MS,
} from './update-check.mjs'

const UPDATE_STATE_FILE = 'update-check.json'
let updateTimer = null
let startupUpdateTimer = null
let updateNotification = null

function runCli(args, env) {
  return new Promise(resolve => {
    const cliEntry = join(process.resourcesPath, 'app.asar.unpacked', 'runtime', 'cli.mjs')
    if (!existsSync(cliEntry)) return resolve(false)
    const child = spawn(process.execPath, [cliEntry, ...args], {
      env: {
        ...process.env,
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      windowsHide: true,
      stdio: 'ignore',
    })
    child.once('error', () => resolve(false))
    child.once('exit', code => resolve(code === 0))
  })
}

function refreshDesktopCliPath() {
  if (!app.isPackaged || process.platform !== 'win32') return Promise.resolve(false)
  const installDir = dirname(process.execPath)
  const helper = join(installDir, 'agent-lens-cli-path.ps1')
  if (!existsSync(helper)) return Promise.resolve(false)

  return new Promise(resolve => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', helper,
      '-Action', 'install',
      '-InstallDir', installDir,
    ], {
      windowsHide: true,
      stdio: 'ignore',
    })
    child.once('error', () => resolve(false))
    child.once('exit', code => resolve(code === 0))
  })
}

async function refreshDesktopIntegration() {
  if (!app.isPackaged) return

  const hookRoot = join(process.resourcesPath, 'app.asar.unpacked', 'runtime', 'hooks')
  if (!existsSync(hookRoot)) return

  const env = {
    AGENT_LENS_DISTRIBUTION: 'desktop',
    AGENT_LENS_INSTALLATION_EXECUTABLE: process.execPath,
    AGENT_LENS_HOOK_ROOT: hookRoot,
    AGENT_LENS_VERSION: app.getVersion(),
  }

  const home = homedir()
  const targets = []
  if (existsSync(join(home, '.codex'))) targets.push('codex')
  if (existsSync(join(home, '.claude'))) targets.push('claude')

  if (!targets.length) {
    // 即使当前没有检测到 Agent，也登记 Desktop 为可用 Hook Provider，
    // 以后安装 Codex / Claude Code 时无需重新安装客户端。
    await runCli(['hook', 'status', 'all', '--json'], env)
    return
  }

  for (const target of targets) {
    await runCli(['hook', 'install', target, '--json'], env)
  }
}

function updateStatePath() {
  return join(app.getPath('userData'), UPDATE_STATE_FILE)
}

async function readUpdateState() {
  try {
    const value = JSON.parse(await readFile(updateStatePath(), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

async function writeUpdateState(state) {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(updateStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function patchUpdateState(patch) {
  const state = await readUpdateState()
  const nextState = { ...state, ...patch }
  await writeUpdateState(nextState)
  return nextState
}

async function openUpdate(update) {
  await shell.openExternal(update.releasePageUrl ?? update.downloadUrl)
}

function publishedAtLabel(update) {
  if (!update?.publishedAt) return null
  const value = new Date(update.publishedAt)
  if (!Number.isFinite(value.getTime())) return null
  return value.toLocaleString('zh-CN', { hour12: false })
}

function releaseDetail(update) {
  const parts = [
    `当前版本：${app.getVersion()}`,
    `最新版本：${update.version}`,
  ]
  const publishedAt = publishedAtLabel(update)
  if (publishedAt) parts.push(`发布时间：${publishedAt}`)
  if (update.releaseNotes) parts.push('', update.releaseNotes)
  parts.push('', 'AgentLens 不会自动替换当前安装。你可以前往 GitHub Release 查看说明并下载安装。')
  return parts.join('\n')
}

async function showUpdateActions(update) {
  const result = await dialog.showMessageBox({
    type: 'info',
    title: 'AgentLens 有新版本',
    message: `AgentLens ${update.version} 可用`,
    detail: releaseDetail(update),
    buttons: ['查看版本', '跳过此版本', '稍后'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })

  if (result.response === 0) {
    await openUpdate(update)
    return 'open'
  }
  if (result.response === 1) {
    try {
      await patchUpdateState({ skippedVersion: update.version })
    } catch {
      // 跳过状态写入失败不能影响桌面端使用。
    }
    return 'skip'
  }
  return 'later'
}

async function notifyUpdate(update) {
  const title = `AgentLens ${update.version} 可用`
  const body = update.prerelease
    ? '发现新的预发布版本。点击查看详情、跳过或稍后处理。'
    : '发现新的正式版本。点击查看详情、跳过或稍后处理。'

  if (Notification.isSupported()) {
    updateNotification?.close()
    updateNotification = new Notification({ title, body })
    updateNotification.once('click', () => {
      void showUpdateActions(update).catch(() => undefined)
    })
    updateNotification.once('close', () => { updateNotification = null })
    updateNotification.show()
    return
  }

  await showUpdateActions(update)
}

async function checkDesktopUpdate() {
  if (!app.isPackaged) return

  const state = await readUpdateState()
  if (!shouldCheckForUpdate(state.lastCheckedAt)) return

  // 先记录本次自动检查尝试。即使网络失败，也不会在每次启动时反复请求 GitHub。
  try {
    await writeUpdateState({ ...state, lastCheckedAt: new Date().toISOString() })
  } catch {
    // 状态文件失败不能阻塞检查，更不能影响桌面端启动。
  }

  let update
  try {
    update = await fetchAvailableUpdate(app.getVersion(), {
      platform: process.platform,
      arch: process.arch,
    })
  } catch {
    // 自动检查更新绝不能改变启动、运行时或离线使用语义。
    return
  }

  const latestState = await readUpdateState()
  if (!shouldNotifyUpdate(update, latestState)) return

  try {
    await patchUpdateState({ lastNotifiedVersion: update.version, lastNotifiedAt: new Date().toISOString() })
  } catch {
    // 通知状态写入失败只可能造成后续重复提醒，不影响主程序。
  }

  try {
    await notifyUpdate(update)
  } catch {
    // 通知或打开浏览器失败同样不能影响主程序。
  }
}

function startDesktopUpdateChecks() {
  if (!app.isPackaged) return

  startupUpdateTimer = setTimeout(() => {
    startupUpdateTimer = null
    void checkDesktopUpdate()
  }, UPDATE_CHECK_STARTUP_DELAY_MS)
  startupUpdateTimer.unref?.()

  updateTimer = setInterval(() => void checkDesktopUpdate(), UPDATE_CHECK_INTERVAL_MS)
  updateTimer.unref?.()
}

app.whenReady().then(async () => {
  if (process.env.AGENT_LENS_DESKTOP_SMOKE === '1') return
  await refreshDesktopCliPath()
  await refreshDesktopIntegration()
  startDesktopUpdateChecks()
}).catch(() => undefined)

app.on('before-quit', () => {
  if (startupUpdateTimer) clearTimeout(startupUpdateTimer)
  if (updateTimer) clearInterval(updateTimer)
  startupUpdateTimer = null
  updateTimer = null
  updateNotification?.close()
  updateNotification = null
})
