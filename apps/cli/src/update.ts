import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

export const PACKAGE_NAME = '@z7ping/agent-lens'
export const REGISTRY_URL = 'https://registry.npmjs.org/@z7ping%2Fagent-lens'
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface ParsedSemver {
  raw: string
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

export interface NpmUpdateInfo {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  installSpec: string | null
}

interface UpdateState {
  lastCheckedAt?: string
  availableVersion?: string | null
}

interface RegistryMetadata {
  versions?: Record<string, { deprecated?: unknown } | null>
}

interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

export function parseSemver(value: unknown): ParsedSemver | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left.localeCompare(right, 'en')
}

export function compareSemver(leftValue: string | ParsedSemver, rightValue: string | ParsedSemver): number {
  const left = typeof leftValue === 'string' ? parseSemver(leftValue) : leftValue
  const right = typeof rightValue === 'string' ? parseSemver(rightValue) : rightValue
  if (!left || !right) throw new Error('无法比较无效的语义化版本')

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0
  if (!left.prerelease.length) return 1
  if (!right.prerelease.length) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const compared = comparePrereleaseIdentifier(leftPart, rightPart)
    if (compared !== 0) return compared
  }
  return 0
}

function normalizedVersion(version: ParsedSemver): string {
  return `${version.major}.${version.minor}.${version.patch}${version.prerelease.length ? `-${version.prerelease.join('.')}` : ''}`
}

export function selectUpdateVersion(metadata: RegistryMetadata, currentVersion: string): string | null {
  const current = parseSemver(currentVersion)
  if (!current || !metadata?.versions || typeof metadata.versions !== 'object') return null
  const acceptPrereleases = current.prerelease.length > 0
  let selected: ParsedSemver | null = null

  for (const [value, manifest] of Object.entries(metadata.versions)) {
    if (manifest && typeof manifest === 'object' && 'deprecated' in manifest && manifest.deprecated) continue
    const candidate = parseSemver(value)
    if (!candidate) continue
    if (!acceptPrereleases && candidate.prerelease.length > 0) continue
    if (compareSemver(candidate, current) <= 0) continue
    if (!selected || compareSemver(candidate, selected) > 0) selected = candidate
  }
  return selected ? normalizedVersion(selected) : null
}

export function shouldCheckForUpdate(lastCheckedAt: string | undefined, now = Date.now(), intervalMs = UPDATE_CHECK_INTERVAL_MS): boolean {
  if (!lastCheckedAt) return true
  const timestamp = Date.parse(lastCheckedAt)
  if (!Number.isFinite(timestamp)) return true
  return now - timestamp >= intervalMs
}

export function npmInstallArgs(version: string): string[] {
  return ['install', '--global', `${PACKAGE_NAME}@${version}`]
}

export async function fetchAvailableNpmUpdate(currentVersion: string, options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<NpmUpdateInfo> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(REGISTRY_URL, {
    headers: {
      Accept: 'application/vnd.npm.install-v1+json',
      'User-Agent': `AgentLens/${currentVersion}`,
    },
    signal: options.signal ?? AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`npm 版本检查失败：HTTP ${response.status}`)
  const metadata = await response.json() as RegistryMetadata
  const latestVersion = selectUpdateVersion(metadata, currentVersion)
  return {
    currentVersion,
    latestVersion: latestVersion ?? currentVersion,
    updateAvailable: latestVersion !== null,
    installSpec: latestVersion ? `${PACKAGE_NAME}@${latestVersion}` : null,
  }
}

function statePath(): string {
  return process.env.AGENT_LENS_CLI_UPDATE_STATE
    ?? join(homedir(), '.agent-lens', '1.0', 'runtime', 'npm-update-check.json')
}

async function readState(): Promise<UpdateState> {
  try {
    return JSON.parse(await readFile(statePath(), 'utf8')) as UpdateState
  } catch {
    return {}
  }
}

async function writeState(state: UpdateState): Promise<void> {
  const path = statePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export async function maybePrintUpdateHint(currentVersion: string): Promise<void> {
  if (process.env.AGENT_LENS_DISABLE_UPDATE_CHECK === '1' || process.env.CI || !process.stderr.isTTY) return
  const state = await readState()
  if (!shouldCheckForUpdate(state.lastCheckedAt)) return
  const checkedAt = new Date().toISOString()
  try {
    const update = await fetchAvailableNpmUpdate(currentVersion, { signal: AbortSignal.timeout(1500) })
    await writeState({ lastCheckedAt: checkedAt, availableVersion: update.updateAvailable ? update.latestVersion : null }).catch(() => undefined)
    if (!update.updateAvailable) return
    console.error('')
    console.error(`[更新] AgentLens ${currentVersion} → ${update.latestVersion}`)
    console.error('       执行：agent-lens update')
  } catch {
    await writeState({ ...state, lastCheckedAt: checkedAt }).catch(() => undefined)
  }
}

function runProcess(command: string, args: string[], options: { inherit?: boolean } = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    if (!options.inherit) {
      child.stdout?.on('data', chunk => { stdout += chunk.toString() })
      child.stderr?.on('data', chunk => { stderr += chunk.toString() })
    }
    child.once('error', reject)
    child.once('exit', code => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function runSelf(args: string[]): Promise<ProcessResult> {
  const entry = process.argv[1]
  if (!entry) return { code: 1, stdout: '', stderr: '无法定位 AgentLens CLI 入口' }
  return runProcess(process.execPath, [entry, ...args])
}

async function npmServiceState(): Promise<{ active: boolean; owner: string | null }> {
  try {
    const result = await runSelf(['service', 'status', '--json'])
    if (result.code !== 0 && !result.stdout.trim()) return { active: false, owner: null }
    const parsed = JSON.parse(result.stdout) as {
      lifecycle?: { active?: boolean }
      runtime?: { owner?: string | null }
    }
    return {
      active: parsed.lifecycle?.active === true,
      owner: typeof parsed.runtime?.owner === 'string' ? parsed.runtime.owner : null,
    }
  } catch {
    return { active: false, owner: null }
  }
}

export async function runUpdateCommand(currentVersion: string, args: string[]): Promise<number> {
  const checkOnly = args.includes('--check')
  const json = args.includes('--json')
  let update: NpmUpdateInfo
  try {
    update = await fetchAvailableNpmUpdate(currentVersion)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (json) console.log(JSON.stringify({ ok: false, currentVersion, error: message }, null, 2))
    else console.error(`检查更新失败：${message}`)
    return 1
  }

  if (checkOnly || !update.updateAvailable) {
    const result = { ok: true, ...update }
    if (json) console.log(JSON.stringify(result, null, 2))
    else if (update.updateAvailable) {
      console.log(`当前版本：${currentVersion}`)
      console.log(`最新版本：${update.latestVersion}`)
      console.log('发现可用更新。')
      console.log('执行：agent-lens update')
    } else {
      console.log(`AgentLens 已是当前通道最新版本（${currentVersion}）。`)
    }
    return 0
  }

  console.log(`准备升级 AgentLens：${currentVersion} → ${update.latestVersion}`)
  const service = await npmServiceState()
  const restartService = service.active && service.owner === 'service'
  if (restartService) {
    console.log('正在停止 npm 后台服务…')
    const stopped = await runSelf(['service', 'stop', '--json'])
    if (stopped.code !== 0) {
      console.error('后台服务停止失败，已取消升级，避免运行时与安装文件状态不一致。')
      if (stopped.stderr.trim()) console.error(stopped.stderr.trim())
      return 1
    }
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const installed = await runProcess(npmCommand, npmInstallArgs(update.latestVersion), { inherit: true })
  if (installed.code !== 0) {
    console.error('npm 升级失败。')
    if (restartService) {
      console.error('尝试恢复原 npm 后台服务…')
      await runSelf(['service', 'start', '--json']).catch(() => undefined)
    }
    return installed.code || 1
  }

  if (restartService) {
    console.log('正在恢复 npm 后台服务…')
    const restarted = await runSelf(['service', 'start', '--json'])
    if (restarted.code !== 0) {
      console.error(`AgentLens 已升级到 ${update.latestVersion}，但后台服务恢复失败。`)
      console.error('请执行：agent-lens service start')
      return 1
    }
  }

  console.log(`AgentLens 已升级到 ${update.latestVersion}。`)
  if (service.owner === 'desktop') console.log('Windows 客户端当前运行时未被 npm 更新命令接管。')
  return 0
}
