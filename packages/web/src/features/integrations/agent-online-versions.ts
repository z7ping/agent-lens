import * as semver from 'semver'

export type AgentLatestVersionSource = 'npm' | 'github'
export type AgentLatestVersionStatus = 'ready' | 'error' | 'unsupported'

export interface AgentLatestVersion {
  status: AgentLatestVersionStatus
  version?: string | undefined
  source?: AgentLatestVersionSource | undefined
  checkedAt?: string | undefined
}

const REMOTE_VERSIONS: Readonly<Record<string, { source: AgentLatestVersionSource; packageName?: string; releaseRepo?: string }>> = {
  pi: { source: 'npm', packageName: '@earendil-works/pi-coding-agent' },
  codex: { source: 'npm', packageName: '@openai/codex' },
  'claude-code': { source: 'npm', packageName: '@anthropic-ai/claude-code' },
  hermes: { source: 'github', releaseRepo: 'NousResearch/hermes-agent' },
  opencode: { source: 'npm', packageName: 'opencode-ai' },
}

const SUCCESS_CACHE_MS = 6 * 60 * 60 * 1000
const ERROR_CACHE_MS = 60 * 1000
const cache = new Map<string, { expiry: number; promise: Promise<AgentLatestVersion> }>()

export function agentVersionComparison(
  localVersions: readonly string[],
  remote: AgentLatestVersion | null,
): 'newer' | 'current' | 'unknown' {
  // A GitHub Hermes tag (v2026.x.y) is not the same version schema as
  // the Hermes CLI version (v0.x.y). Never compare those as SemVer.
  if (remote?.status !== 'ready' || remote.source !== 'npm' || !remote.version || localVersions.length !== 1) return 'unknown'
  const current = semver.valid(localVersions[0]?.trim().replace(/^v/, '') ?? '')
  const latest = semver.valid(remote.version.trim().replace(/^v/, ''))
  if (!current || !latest) return 'unknown'
  return semver.gt(latest, current) ? 'newer' : 'current'
}

export async function checkAgentLatestVersion(
  productId: string,
  options: { fetchImpl?: typeof fetch; force?: boolean; now?: number } = {},
): Promise<AgentLatestVersion> {
  const entry = REMOTE_VERSIONS[productId]
  if (!entry) return { status: 'unsupported' }
  const now = options.now ?? Date.now()
  const existing = cache.get(productId)
  if (!options.force && existing && existing.expiry > now) return existing.promise
  // Allow-list of URL origins and product IDs: never fetch a URL supplied by the browser user.
  const url = entry.source === 'npm'
    ? 'https://registry.npmjs.org/' + encodeURIComponent(entry.packageName!) + '/latest'
    : 'https://api.github.com/repos/' + entry.releaseRepo + '/releases/latest'
  const fetchImpl = options.fetchImpl ?? fetch
  const promise: Promise<AgentLatestVersion> = (async () => {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) throw new Error('Release source unavailable')
      const data: unknown = await response.json()
      if (!data || typeof data !== 'object') throw new Error('Invalid version source')
      const raw = data as Record<string, unknown>
      const version = entry.source === 'npm' ? raw.version : raw.tag_name
      if (typeof version !== 'string' || !version.trim() || version.length > 96) throw new Error('Missing version')
      return { status: 'ready', version: version.trim(), source: entry.source, checkedAt: new Date(now).toISOString() }
    } catch {
      return { status: 'error', source: entry.source, checkedAt: new Date(now).toISOString() }
    }
  })()
  cache.set(productId, { expiry: now + SUCCESS_CACHE_MS, promise })
  void promise.then(result => {
    if (result.status !== 'ready' && cache.get(productId)?.promise === promise) {
      cache.set(productId, { expiry: now + ERROR_CACHE_MS, promise })
    }
  })
  return promise
}
