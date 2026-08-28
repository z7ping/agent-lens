import { pathToFileURL } from 'node:url'

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/

export function resolveReleaseVersion(currentVersion, releaseType = 'auto') {
  const current = parseSemver(currentVersion)
  switch (releaseType.toLowerCase()) {
    case 'auto':
      if (current.prerelease.length > 0) {
        const prerelease = [...current.prerelease]
        const last = prerelease.at(-1)
        if (/^\d+$/.test(last)) prerelease[prerelease.length - 1] = String(Number(last) + 1)
        else prerelease.push('1')
        return formatSemver({ ...current, prerelease })
      }
      return formatSemver({ ...current, patch: current.patch + 1, prerelease: [] })
    case 'patch':
      return formatSemver({ ...current, patch: current.patch + 1, prerelease: [] })
    case 'minor':
      return formatSemver({ ...current, minor: current.minor + 1, patch: 0, prerelease: [] })
    case 'major':
      return formatSemver({ ...current, major: current.major + 1, minor: 0, patch: 0, prerelease: [] })
    case 'stable':
      if (current.prerelease.length === 0) throw new Error(`当前版本 ${currentVersion} 已经是正式版`)
      return formatSemver({ ...current, prerelease: [] })
    default:
      throw new Error(`不支持的发版类型：${releaseType}`)
  }
}

export function validateRequestedVersion(currentVersion, requestedVersion) {
  const current = parseSemver(currentVersion)
  const requested = parseSemver(requestedVersion)
  if (compareSemver(requested, current) < 0) {
    throw new Error(`目标版本 ${requestedVersion} 不能低于当前版本 ${currentVersion}`)
  }
  return formatSemver(requested)
}

function parseSemver(version) {
  const match = semverPattern.exec(version)
  if (!match) throw new Error(`版本号不是合法 SemVer：${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  }
}

function formatSemver(version) {
  const base = `${version.major}.${version.minor}.${version.patch}`
  return version.prerelease.length > 0 ? `${base}-${version.prerelease.join('.')}` : base
}

function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0
    return left.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [, , currentVersion, operation = 'auto', requestedVersion] = process.argv
    const version = operation === 'explicit'
      ? validateRequestedVersion(currentVersion, requestedVersion)
      : resolveReleaseVersion(currentVersion, operation)
    console.log(version)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
