import * as semver from 'semver'
import { translateProduct } from '../i18n/runtime'
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@z7ping%2Fagent-lens'
const GITHUB_RELEASES_API = 'https://api.github.com/repos/z7ping/agent-lens/releases?per_page=20'
const GITHUB_RELEASES_URL = 'https://github.com/z7ping/agent-lens/releases'
const STORAGE_KEY = 'agent-lens:web-update-state:v1'

const WEB_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface ParsedSemver {
  raw: string
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

interface RegistryMetadata {
  versions?: Record<string, { deprecated?: unknown } | null>
}

interface GithubRelease {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  published_at?: unknown
  html_url?: unknown
  draft?: unknown
}

export interface WebUpdateInfo {
  currentVersion: string
  latestVersion: string
  releasePageUrl: string
  publishedAt: string | null
  releaseNotes: string | null
  installCommand: string
  fallbackInstallCommand: string
}

export interface WebUpdateState {
  lastCheckedAt?: string
  availableVersion?: string | null
  releasePageUrl?: string | null
  publishedAt?: string | null
  releaseNotes?: string | null
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function parseSemver(value: unknown): ParsedSemver | null {
  if (typeof value !== 'string') return null
  const normalized = semver.clean(value.trim())
  if (!normalized || !semver.valid(normalized)) return null
  const parsed = semver.parse(normalized)
  if (!parsed) return null
  return {
    raw: value,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: parsed.prerelease.map(String),
  }
}

function comparableSemver(value: string | ParsedSemver): string | null {
  if (typeof value === 'string') {
    const normalized = semver.clean(value.trim())
    return normalized && semver.valid(normalized) ? normalized : null
  }
  const prerelease = value.prerelease.length ? `-${value.prerelease.join('.')}` : ''
  return semver.valid(`${value.major}.${value.minor}.${value.patch}${prerelease}`)
}

export function compareSemver(leftValue: string | ParsedSemver, rightValue: string | ParsedSemver): number {
  const left = comparableSemver(leftValue)
  const right = comparableSemver(rightValue)
  if (!left || !right) throw new Error(translateProduct('errors:invalidSemver'))
  return semver.compare(left, right)
}

function normalizedVersion(version: ParsedSemver): string {
  const prerelease = version.prerelease.length ? `-${version.prerelease.join('.')}` : ''
  return `${version.major}.${version.minor}.${version.patch}${prerelease}`
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

export function shouldCheckForUpdate(lastCheckedAt: string | undefined, now = Date.now(), intervalMs = WEB_UPDATE_CHECK_INTERVAL_MS): boolean {
  if (!lastCheckedAt) return true
  const timestamp = Date.parse(lastCheckedAt)
  if (!Number.isFinite(timestamp)) return true
  return now - timestamp >= intervalMs
}

export function shouldCheckWebUpdateForRuntimeOwner(owner: string | null | undefined): boolean {
  return owner !== 'desktop'
}

function safeStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function readWebUpdateState(storage: StorageLike | null = safeStorage()): WebUpdateState {
  if (!storage) return {}
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as WebUpdateState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeWebUpdateState(state: WebUpdateState, storage: StorageLike | null = safeStorage()): void {
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 浏览器存储不可用不影响 AgentLens 主功能。
  }
}

function updateFromState(currentVersion: string, state: WebUpdateState): WebUpdateInfo | null {
  const latestVersion = state.availableVersion
  if (!latestVersion || !parseSemver(latestVersion) || compareSemver(latestVersion, currentVersion) <= 0) return null
  return {
    currentVersion,
    latestVersion,
    releasePageUrl: state.releasePageUrl || `${GITHUB_RELEASES_URL}/tag/v${latestVersion}`,
    publishedAt: state.publishedAt ?? null,
    releaseNotes: state.releaseNotes ?? null,
    installCommand: 'agent-lens update',
    fallbackInstallCommand: `npm install -g @z7ping/agent-lens@${latestVersion}`,
  }
}

function releaseNotes(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > 1_200 ? `${trimmed.slice(0, 1_197)}...` : trimmed
}

async function fetchReleaseMetadata(version: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<Pick<WebUpdateState, 'releasePageUrl' | 'publishedAt' | 'releaseNotes'>> {
  try {
    const response = await fetchImpl(GITHUB_RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal,
    })
    if (!response.ok) return {}
    const releases = await response.json() as GithubRelease[]
    const release = Array.isArray(releases)
      ? releases.find(item => item?.draft !== true && (item?.tag_name === version || item?.tag_name === `v${version}`))
      : null
    if (!release) return {}
    return {
      releasePageUrl: typeof release.html_url === 'string' ? release.html_url : null,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
      releaseNotes: releaseNotes(release.body),
    }
  } catch {
    return {}
  }
}

async function fetchRuntimeOwner(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetchImpl('/api/v1/health', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(1_500),
    })
    if (!response.ok && response.status !== 503) return null
    const body = await response.json() as { runtime?: { owner?: unknown } }
    return typeof body.runtime?.owner === 'string' ? body.runtime.owner : null
  } catch {
    return null
  }
}

export async function checkWebUpdate(
  currentVersion: string,
  options: {
    fetchImpl?: typeof fetch
    storage?: StorageLike | null
    runtimeOwner?: string | null
    now?: number
    force?: boolean
  } = {},
): Promise<WebUpdateInfo | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  const storage = options.storage === undefined ? safeStorage() : options.storage
  const runtimeOwner = options.runtimeOwner === undefined ? await fetchRuntimeOwner(fetchImpl) : options.runtimeOwner
  if (!shouldCheckWebUpdateForRuntimeOwner(runtimeOwner)) return null

  const state = readWebUpdateState(storage)
  const now = options.now ?? Date.now()
  if (!options.force && !shouldCheckForUpdate(state.lastCheckedAt, now)) {
    return updateFromState(currentVersion, state)
  }

  const checkedAt = new Date(now).toISOString()
  writeWebUpdateState({ ...state, lastCheckedAt: checkedAt }, storage)

  try {
    const response = await fetchImpl(NPM_REGISTRY_URL, {
      headers: { Accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(4_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const metadata = await response.json() as RegistryMetadata
    const latestVersion = selectUpdateVersion(metadata, currentVersion)
    if (!latestVersion) {
      writeWebUpdateState({ lastCheckedAt: checkedAt, availableVersion: null }, storage)
      return null
    }

    const release = await fetchReleaseMetadata(latestVersion, fetchImpl, AbortSignal.timeout(3_000))
    const nextState: WebUpdateState = {
      lastCheckedAt: checkedAt,
      availableVersion: latestVersion,
      releasePageUrl: release.releasePageUrl ?? `${GITHUB_RELEASES_URL}/tag/v${latestVersion}`,
      publishedAt: release.publishedAt ?? null,
      releaseNotes: release.releaseNotes ?? null,
    }
    writeWebUpdateState(nextState, storage)
    return updateFromState(currentVersion, nextState)
  } catch {
    const fallbackState = { ...state, lastCheckedAt: checkedAt }
    writeWebUpdateState(fallbackState, storage)
    return updateFromState(currentVersion, fallbackState)
  }
}
