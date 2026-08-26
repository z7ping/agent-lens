const RELEASES_API = 'https://api.github.com/repos/z7ping/agent-lens/releases?per_page=20'
const WINDOWS_SETUP_PATTERN = /^AgentLens-.*-Setup-x64\.exe$/i
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export function parseSemver(value) {
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

function comparePrereleaseIdentifier(left, right) {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left.localeCompare(right, 'en')
}

export function compareSemver(leftValue, rightValue) {
  const left = typeof leftValue === 'string' ? parseSemver(leftValue) : leftValue
  const right = typeof rightValue === 'string' ? parseSemver(rightValue) : rightValue
  if (!left || !right) throw new Error('无法比较无效的语义化版本')

  for (const key of ['major', 'minor', 'patch']) {
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

function releaseVersion(release) {
  return parseSemver(release?.tag_name ?? release?.name ?? '')
}

function releaseDownloadUrl(release) {
  const setup = Array.isArray(release?.assets)
    ? release.assets.find(asset => WINDOWS_SETUP_PATTERN.test(asset?.name ?? '') && typeof asset?.browser_download_url === 'string')
    : null
  return setup?.browser_download_url ?? release?.html_url ?? null
}

export function selectUpdateRelease(releases, currentVersion) {
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
  const downloadUrl = releaseDownloadUrl(selected)
  if (!downloadUrl) return null
  return {
    version: `${selectedVersion.major}.${selectedVersion.minor}.${selectedVersion.patch}${selectedVersion.prerelease.length ? `-${selectedVersion.prerelease.join('.')}` : ''}`,
    prerelease: selectedVersion.prerelease.length > 0 || selected.prerelease === true,
    releasePageUrl: selected.html_url ?? downloadUrl,
    downloadUrl,
    publishedAt: selected.published_at ?? null,
  }
}

export function shouldCheckForUpdate(lastCheckedAt, now = Date.now(), intervalMs = UPDATE_CHECK_INTERVAL_MS) {
  if (!lastCheckedAt) return true
  const timestamp = Date.parse(lastCheckedAt)
  if (!Number.isFinite(timestamp)) return true
  return now - timestamp >= intervalMs
}

export async function fetchAvailableUpdate(currentVersion, options = {}) {
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
  return selectUpdateRelease(releases, currentVersion)
}
