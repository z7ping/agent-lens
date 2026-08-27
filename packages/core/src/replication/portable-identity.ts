import type { PortableIdentity } from './types'

export const PROJECT_REPOSITORY_IDENTITY_ALGORITHM = 'project-repository-v1' as const
export const ASSET_UPSTREAM_IDENTITY_ALGORITHM = 'asset-upstream-v1' as const

const GIT_PROTOCOLS = new Set(['http:', 'https:', 'ssh:', 'git:', 'git+ssh:'])
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'http:': '80',
  'https:': '443',
  'ssh:': '22',
  'git:': '9418',
  'git+ssh:': '22',
}

function isLocalPath(value: string): boolean {
  return value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('~/')
    || /^\\\\/.test(value)
    || /^[A-Za-z]:[\\/]/.test(value)
}

function normalizedRepositoryPath(hostname: string, path: string): string | null {
  let normalized = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  if (!normalized) return null

  // GitHub repository owner/name lookup is case-insensitive. For unknown providers,
  // preserving path case is safer than guessing provider semantics.
  if (hostname === 'github.com') normalized = normalized.toLowerCase()
  return normalized || null
}

function normalizedHost(hostname: string, port = '', protocol = ''): string | null {
  const host = hostname.trim().toLowerCase()
  if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return null
  }
  const normalizedPort = port && DEFAULT_PORTS[protocol] !== port ? `:${port}` : ''
  return `${host}${normalizedPort}`
}

function normalizeRepositoryUri(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (!GIT_PROTOCOLS.has(url.protocol)) return null

  const host = normalizedHost(url.hostname, url.port, url.protocol)
  if (!host) return null
  const path = normalizedRepositoryPath(url.hostname.toLowerCase(), url.pathname)
  if (!path) return null
  return `${host}/${path}`
}

function normalizeScpLikeRepository(value: string): string | null {
  const match = /^(?:[^@\s/:]+@)?([^\s/:]+):(.*)$/.exec(value)
  if (!match) return null
  const hostname = match[1]!
  // Require an actual host-like token so namespaced identities such as npm:pkg
  // are not accidentally interpreted as Git remotes.
  if (!hostname.includes('.') && hostname !== 'localhost') return null
  const host = normalizedHost(hostname)
  if (!host) return null
  const path = normalizedRepositoryPath(hostname.toLowerCase(), match[2]!)
  if (!path) return null
  return `${host}/${path}`
}

export function normalizeRepositoryIdentity(value: string | undefined): string | null {
  const input = value?.trim()
  if (!input || isLocalPath(input) || /^file:/i.test(input)) return null
  if (input.includes('://')) return normalizeRepositoryUri(input)
  return normalizeScpLikeRepository(input)
}

export function projectRepositoryPortableIdentity(
  repositoryIdentity: string | undefined,
): PortableIdentity<'project-repository-v1'> | null {
  const normalized = normalizeRepositoryIdentity(repositoryIdentity)
  if (!normalized) return null
  return {
    algorithm: PROJECT_REPOSITORY_IDENTITY_ALGORITHM,
    normalized,
  }
}

function normalizeNamespacedAssetIdentity(value: string): string | null {
  const match = /^([a-z][a-z0-9+.-]{1,31}):(\S+)$/.exec(value)
  if (!match) return null
  const scheme = match[1]!.toLowerCase()
  if (scheme === 'file' || scheme.length === 1) return null
  return `${scheme}:${match[2]!}`
}

export function assetUpstreamPortableIdentity(
  upstreamIdentity: string | undefined,
): PortableIdentity<'asset-upstream-v1'> | null {
  const input = upstreamIdentity?.trim()
  if (!input || isLocalPath(input) || /^file:/i.test(input)) return null

  const repository = normalizeRepositoryIdentity(input)
  const normalized = repository
    ? `repository:${repository}`
    : normalizeNamespacedAssetIdentity(input)
  if (!normalized) return null

  return {
    algorithm: ASSET_UPSTREAM_IDENTITY_ALGORITHM,
    normalized,
  }
}
