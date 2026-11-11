import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const executable = process.argv[2]
if (!executable) throw new Error('用法：node scripts/smoke-desktop-window.mjs <packaged-AppImage-or-executable>')
const target = resolve(executable)
if (!existsSync(target)) throw new Error(`桌面可执行文件不存在：${target}`)

const root = await mkdtemp(join(tmpdir(), 'agentlens-window-smoke-'))
const bootLog = join(root, 'desktop.log')
const daemonLog = join(root, 'daemon.log')
const port = 58000 + Math.floor(Math.random() * 1000)
const env = {
  ...process.env,
  AGENT_LENS_DESKTOP_SMOKE: '1',
  AGENT_LENS_DESKTOP_BOOT_LOG: bootLog,
  AGENT_LENS_LOG_DIR: root,
  AGENT_LENS_PORT: String(port),
  AGENT_LENS_DB_PATH: join(root, 'agent-lens.db'),
  AGENT_LENS_VAULT_PATH: join(root, 'vault'),
  AGENT_LENS_ENABLED_SOURCES: 'none',
  GTK_THEME: 'Adwaita:light',
}
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(target, ['--no-sandbox', `--user-data-dir=${join(root, 'user-data')}`], {
  env,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
let spawnError = null
child.once('error', error => { spawnError = error })
child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(-16000) })
child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-16000) })

async function readLog(path) {
  return readFile(path, 'utf8').catch(() => '')
}
function stopGroup(signal) {
  if (!child.pid) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // Already exited.
  }
}

try {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null) {
      throw new Error(`打包桌面端提前退出：exit=${child.exitCode} signal=${child.signalCode ?? 'none'}`)
    }
    const log = await readLog(bootLog)
    if (log.includes('bootstrap main:main-window-rendered')
      && log.includes('bootstrap main:startup-themes-validated')) {
      console.log('[AgentLens] 打包桌面主界面渲染 + 明暗启动页冒烟通过')
      break
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  const finalLog = await readLog(bootLog)
  if (!finalLog.includes('bootstrap main:main-window-rendered')
    || !finalLog.includes('bootstrap main:startup-themes-validated')) {
    throw new Error('90 秒内未确认主界面渲染和启动页明暗主题')
  }
} catch (error) {
  const logs = await Promise.all([readLog(bootLog), readLog(daemonLog)])
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n--- desktop.log ---\n${logs[0].slice(-12000)}\n--- daemon.log ---\n${logs[1].slice(-12000)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
} finally {
  stopGroup('SIGTERM')
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1200))
  stopGroup('SIGKILL')
  await rm(root, { recursive: true, force: true })
}
