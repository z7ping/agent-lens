import semver from 'semver'

const RELEASES_API = 'https://api.github.com/repos/z7ping/agent-lens/releases?per_page=20'
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const UPDATE_CHECK_STARTUP_DELAY_MS = 8_000
export const SUPPORTED_DESKTOP_ARCHITECTURES = ['x64']

export function isSupportedDesktopArchitecture(arch) {
  return SUPPORTED_DESKTOP_ARCHITECTURES.includes(String(arch))
}

function normalizedSemver(value) {
  if (typeof value !== 'string') return null
  const cleaned = semver.clean(value.trim())
  return cleaned && semver.valid(cleaned) ? cleaned : null
}

export function parseSemver(value) {
  const normalized = normalizedSemver(value)
  if (!normalized) return null
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

function comparableSemver(value) {
  if (typeof value === 'string') return normalizedSemver(value)
  if (!value || typeof value !== 'object') return null
  const prerelease = Array.isArray(value.prerelease) && value.prerelease.length
    ? `-${value.prerelease.join('.')}`
    : ''
  return normalizedSemver(`${value.major}.${value.minor}.${value.patch}${prerelease}`)
}

export function compareSemver(leftValue, rightValue) {
  const left = comparableSemver(leftValue)
  const right = comparableSemver(rightValue)
  if (!left || !right) throw new Error('无法比较无效的语义化版本')
  return semver.compare(left, right)
}

function releaseVersion(release) {
  return parseSemver(release?.tag_name ?? release?.name ?? '')
}

function assetPriority(name, platform, arch) {
  if (typeof name !== 'string') return 0
  const escapedArch = String(arch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  if (platform === 'darwin') {
    if (new RegExp(`^AgentLens-.*-macOS-${escapedArch}\\.dmg$`, 'i').test(name)) return 30
    if (new RegExp(`^AgentLens-.*-macOS-${escapedArch}\\.zip$`, 'i').test(name)) return 20
    return 0
  }

  if (platform === 'linux') {
    if (new RegExp(`^AgentLens-.*-Linux-${escapedArch}\\.AppImage$`, 'i').test(name)) return 30
    if (new RegExp(`^AgentLens-.*-Linux-${escapedArch}\\.deb$`, 'i').test(name)) return 20
    return 0
  }

  if (new RegExp(`^AgentLens-.*-Setup-${escapedArch}\\.exe$`, 'i').test(name)) return 30
  return 0
}

function releaseDownloadUrl(release, options = {}) {
  const platform = options.platform ?? 'win32'
  const arch = options.arch ?? 'x64'
  const assets = Array.isArray(release?.assets) ? release.assets : []

  let selected = null
  let selectedPriority = 0
  for (const asset of assets) {
    if (typeof asset?.browser_download_url !== 'string') continue
    const priority = assetPriority(asset?.name ?? '', platform, arch)
    if (priority > selectedPriority) {
      selected = asset
      selectedPriority = priority
    }
  }

  return selected?.browser_download_url ?? release?.html_url ?? null
}

function releaseNotes(release) {
  if (typeof release?.body !== 'string') return null
  const value = release.body.trim()
  if (!value) return null
  return value.length > 1_200 ? `${value.slice(0, 1_197)}...` : value
}

export function selectUpdateRelease(releases, currentVersion, options = {}) {
  const arch = options.arch ?? 'x64'
  if (!isSupportedDesktopArchitecture(arch)) return null

  const current = parseSemver(currentVersion)
  if (!current || !Array.isArray(releases)) return null
  const acceptPrereleases = current.prerelease.length > 0

  let selected = null
  let selectedVersion = null
  for (const release of releases) {
    if (!release || release.draft === true) continue
    const version = releaseVersion(release)
    if (!version) continue
    if (!acceptPrereleases && (release.prerelease === true || version.prerelease.length > 0)) continue
    if (compareSemver(version, current) <= 0) continue
    if (!selectedVersion || compareSemver(version, selectedVersion) > 0) {
      selected = release
      selectedVersion = version
    }
  }

  if (!selected || !selectedVersion) return null
  const downloadUrl = releaseDownloadUrl(selected, { ...options, arch })
  if (!downloadUrl) return null
  return {
    version: `${selectedVersion.major}.${selectedVersion.minor}.${selectedVersion.patch}${selectedVersion.prerelease.length ? `-${selectedVersion.prerelease.join('.')}` : ''}`,
    prerelease: selectedVersion.prerelease.length > 0 || selected.prerelease === true,
    releasePageUrl: selected.html_url ?? downloadUrl,
    downloadUrl,
    publishedAt: selected.published_at ?? null,
    releaseNotes: releaseNotes(selected),
  }
}

export function shouldCheckForUpdate(lastCheckedAt, now = Date.now(), intervalMs = UPDATE_CHECK_INTERVAL_MS) {
  if (!lastCheckedAt) return true
  const timestamp = Date.parse(lastCheckedAt)
  if (!Number.isFinite(timestamp)) return true
  return now - timestamp >= intervalMs
}

export function shouldNotifyUpdate(update, state = {}) {
  if (!update?.version) return false
  return state.skippedVersion !== update.version
}

export async function fetchAvailableUpdate(currentVersion, options = {}) {
  const arch = options.arch ?? 'x64'
  if (!isSupportedDesktopArchitecture(arch)) return null

  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(RELEASES_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `AgentLens/${currentVersion}`,
    },
    signal: options.signal ?? AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`GitHub Release 检查失败：HTTP ${response.status}`)
  const releases = await response.json()
  return selectUpdateRelease(releases, currentVersion, {
    platform: options.platform ?? 'win32',
    arch,
  })
}
