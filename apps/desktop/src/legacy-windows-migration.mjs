import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'

const LEGACY_PACKAGE_NAME = '@z7ping/agent-lens'
const LEGACY_STARTUP_FILE = 'AgentLens.vbs'

function normalizedWindowsText(value) {
  return String(value ?? '').replace(/\//g, '\\').toLowerCase()
}

export function legacyWindowsPaths({
  homeDir = homedir(),
  appData = process.env.APPDATA || win32.join(homeDir, 'AppData', 'Roaming'),
} = {}) {
  const legacyRoot = win32.join(homeDir, '.agent-lens')
  const legacyInstallDir = win32.join(legacyRoot, 'app')
  return {
    legacyRoot,
    legacyInstallDir,
    legacyPackagePath: win32.join(legacyInstallDir, 'package.json'),
    legacyServerPath: win32.join(legacyInstallDir, 'server.js'),
    legacyPidFile: win32.join(legacyRoot, 'run', 'server.pid'),
    legacyStartupFile: win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', LEGACY_STARTUP_FILE),
    markerFile: win32.join(legacyRoot, '1.0', 'runtime', 'migrations', 'legacy-windows-0x.json'),
  }
}

export function isLegacyAppInfo(info) {
  if (!info || typeof info !== 'object') return false
  if (info.name !== LEGACY_PACKAGE_NAME || typeof info.version !== 'string') return false
  const major = Number.parseInt(info.version.split('.')[0] ?? '', 10)
  return Number.isInteger(major) && major === 0
}

export function looksLikeLegacyProcess(processInfo, legacyInstallDir) {
  const commandLine = normalizedWindowsText(processInfo?.commandLine)
  const installDir = normalizedWindowsText(win32.normalize(legacyInstallDir))
  if (!commandLine || !installDir) return false
  if (!commandLine.includes(installDir)) return false
  return commandLine.includes('server.js') || commandLine.includes('cli.js')
}

export function isLegacyStartupContent(content, legacyInstallDir) {
  const source = normalizedWindowsText(content)
  const installDir = normalizedWindowsText(win32.normalize(legacyInstallDir))
  return Boolean(source && installDir && source.includes(installDir) && source.includes('server.js'))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => resolve({
      code: code ?? 1,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }))
  })
}

async function readLegacyAppInfo(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/app-info`, {
      signal: AbortSignal.timeout(1200),
    })
    if (!response.ok) return null
    const info = await response.json()
    return isLegacyAppInfo(info) ? info : null
  } catch {
    return null
  }
}

async function readLegacyInstalledPackage(paths) {
  try {
    const info = JSON.parse(await readFile(paths.legacyPackagePath, 'utf8'))
    return isLegacyAppInfo(info) ? info : null
  } catch {
    return null
  }
}

async function listListeningProcesses(port, runPowerShellImpl = runPowerShell) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$connections = @(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue)`,
    '$seen = @{}',
    '$items = @()',
    'foreach ($connection in $connections) {',
    '  $ownerId = [int]$connection.OwningProcess',
    '  if ($seen.ContainsKey([string]$ownerId)) { continue }',
    '  $seen[[string]$ownerId] = $true',
    '  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $ownerId) -ErrorAction SilentlyContinue',
    '  $items += [pscustomobject]@{ processId = $ownerId; executablePath = [string]$proc.ExecutablePath; commandLine = [string]$proc.CommandLine }',
    '}',
    'ConvertTo-Json -InputObject @($items) -Compress',
  ].join('\n')
  const result = await runPowerShellImpl(script)
  if (result.code !== 0) throw new Error(`读取端口 ${port} 的 Windows 进程信息失败${result.stderr ? `：${result.stderr}` : ''}`)
  if (!result.stdout) return []
  const parsed = JSON.parse(result.stdout)
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function terminateProcess(processId, runPowerShellImpl = runPowerShell) {
  const result = await runPowerShellImpl(`Stop-Process -Id ${Number(processId)} -Force -ErrorAction Stop`)
  if (result.code !== 0) throw new Error(`停止旧版 AgentLens 进程 PID ${processId} 失败${result.stderr ? `：${result.stderr}` : ''}`)
}

function isPortOpen(port, timeoutMs = 250) {
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

async function waitForPortClosed(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!await isPortOpen(port)) return true
    await sleep(150)
  }
  return !await isPortOpen(port)
}

async function removeOwnedLegacyStartup(paths) {
  if (!existsSync(paths.legacyStartupFile)) return false
  try {
    const content = await readFile(paths.legacyStartupFile, 'utf8')
    if (!isLegacyStartupContent(content, paths.legacyInstallDir)) return false
    await rm(paths.legacyStartupFile, { force: true })
    return true
  } catch {
    return false
  }
}

async function writeMigrationMarker(paths, result) {
  await mkdir(win32.dirname(paths.markerFile), { recursive: true })
  await writeFile(paths.markerFile, `${JSON.stringify({
    version: 1,
    migratedAt: new Date().toISOString(),
    ...result,
  }, null, 2)}\n`, 'utf8')
}

export async function migrateLegacyWindowsRuntime({
  port,
  platform = process.platform,
  homeDir = homedir(),
  appData = process.env.APPDATA,
  fetchImpl = fetch,
  runPowerShellImpl = runPowerShell,
  logger = () => {},
} = {}) {
  if (platform !== 'win32') return { changed: false, skipped: true }
  if (!Number.isInteger(Number(port)) || Number(port) <= 0) throw new Error(`无效的 AgentLens 端口：${String(port)}`)

  const paths = legacyWindowsPaths({ homeDir, appData })
  const startupRemovedBeforeProbe = await removeOwnedLegacyStartup(paths)
  if (startupRemovedBeforeProbe) logger(`--- retired legacy Windows startup ${paths.legacyStartupFile} ---`)

  const [httpInfo, installedInfo] = await Promise.all([
    readLegacyAppInfo(Number(port), fetchImpl),
    readLegacyInstalledPackage(paths),
  ])
  const legacyInfo = httpInfo ?? installedInfo

  if (!legacyInfo) {
    if (startupRemovedBeforeProbe) {
      const result = {
        changed: true,
        legacyVersion: null,
        stoppedPids: [],
        removedStartup: true,
        legacyInstallDir: paths.legacyInstallDir,
        identitySource: 'startup-only',
      }
      await writeMigrationMarker(paths, result)
      return result
    }
    return { changed: false, legacyVersion: null, stoppedPids: [], removedStartup: false }
  }

  const processes = await listListeningProcesses(Number(port), runPowerShellImpl)
  const owned = processes.filter(item => looksLikeLegacyProcess(item, paths.legacyInstallDir))
  const identitySource = httpInfo ? (installedInfo ? 'http+install' : 'http') : 'install'

  if (owned.length === 0) {
    if (httpInfo) {
      throw new Error(`检测到 AgentLens ${httpInfo.version} 正占用端口 ${port}，但无法确认其 Windows 进程归属。为避免误杀其他进程，已停止自动迁移。`)
    }
    if (startupRemovedBeforeProbe) {
      const result = {
        changed: true,
        legacyVersion: installedInfo?.version ?? null,
        stoppedPids: [],
        removedStartup: true,
        legacyInstallDir: paths.legacyInstallDir,
        identitySource,
      }
      await writeMigrationMarker(paths, result)
      return result
    }
    return { changed: false, legacyVersion: installedInfo?.version ?? null, stoppedPids: [], removedStartup: false }
  }

  logger(`--- detected legacy AgentLens ${legacyInfo.version} on port ${port} identity=${identitySource} ---`)
  const stoppedPids = []
  for (const processInfo of owned) {
    const processId = Number(processInfo.processId)
    if (!Number.isInteger(processId) || processId <= 0) continue
    await terminateProcess(processId, runPowerShellImpl)
    stoppedPids.push(processId)
    logger(`--- stopped legacy AgentLens pid=${processId} version=${legacyInfo.version} ---`)
  }

  if (!await waitForPortClosed(Number(port))) {
    throw new Error(`已停止旧版 AgentLens 进程，但端口 ${port} 仍被占用。请检查是否存在其他程序占用该端口。`)
  }

  const startupRemovedAfterStop = await removeOwnedLegacyStartup(paths)
  const result = {
    changed: stoppedPids.length > 0 || startupRemovedBeforeProbe || startupRemovedAfterStop,
    legacyVersion: legacyInfo.version,
    stoppedPids,
    removedStartup: startupRemovedBeforeProbe || startupRemovedAfterStop,
    legacyInstallDir: paths.legacyInstallDir,
    identitySource,
  }
  await writeMigrationMarker(paths, result)
  logger(`--- legacy Windows migration completed version=${legacyInfo.version} stopped=${stoppedPids.join(',') || 'none'} startupRemoved=${result.removedStartup} identity=${identitySource} ---`)
  return result
}

export const legacyWindowsMigrationInternals = {
  readLegacyAppInfo,
  readLegacyInstalledPackage,
  listListeningProcesses,
  removeOwnedLegacyStartup,
  runPowerShell,
  terminateProcess,
  waitForPortClosed,
}
