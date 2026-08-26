import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { app, dialog, Notification, shell } from 'electron'
import {
  fetchAvailableUpdate,
  shouldCheckForUpdate,
  UPDATE_CHECK_INTERVAL_MS,
} from './update-check.mjs'

const UPDATE_STATE_FILE = 'update-check.json'
let updateTimer = null
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

async function openUpdate(update) {
  await shell.openExternal(update.downloadUrl)
}

async function notifyUpdate(update) {
  const title = `AgentLens ${update.version} 可用`
  const body = update.prerelease
    ? '发现新的预发布版本，点击前往下载。'
    : '发现新的正式版本，点击前往下载。'

  if (Notification.isSupported()) {
    updateNotification?.close()
    updateNotification = new Notification({ title, body })
    updateNotification.once('click', () => void openUpdate(update))
    updateNotification.once('close', () => { updateNotification = null })
    updateNotification.show()
    return
  }

  const result = await dialog.showMessageBox({
    type: 'info',
    title: 'AgentLens 有新版本',
    message: title,
    detail: '当前版本不会自动替换。你可以下载对应平台的新版本覆盖升级，现有 ~/.agent-lens/1.0 数据会保留。',
    buttons: ['前往下载', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (result.response === 0) await openUpdate(update)
}

async function checkDesktopUpdate() {
  if (!app.isPackaged) return

  const state = await readUpdateState()
  if (!shouldCheckForUpdate(state.lastCheckedAt)) return

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

  const checkedAt = new Date().toISOString()
  const nextState = { ...state, lastCheckedAt: checkedAt }
  const shouldNotify = update && state.lastNotifiedVersion !== update.version
  if (shouldNotify) nextState.lastNotifiedVersion = update.version

  try {
    await writeUpdateState(nextState)
  } catch {
    // 状态文件失败只会导致后续重复检查，不能影响桌面端可用性。
  }

  if (shouldNotify) {
    try {
      await notifyUpdate(update)
    } catch {
      // 通知或打开浏览器失败同样不能影响主程序。
    }
  }
}

async function startDesktopUpdateChecks() {
  if (!app.isPackaged) return
  await checkDesktopUpdate()
  updateTimer = setInterval(() => void checkDesktopUpdate(), UPDATE_CHECK_INTERVAL_MS)
  updateTimer.unref?.()
}

app.whenReady().then(async () => {
  await refreshDesktopIntegration()
  await startDesktopUpdateChecks()
}).catch(() => undefined)

app.on('before-quit', () => {
  if (updateTimer) clearInterval(updateTimer)
  updateTimer = null
  updateNotification?.close()
  updateNotification = null
})
