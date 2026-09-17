import {
  AGENT_LENS_PROTOCOL_VERSION,
  type PiEcosystemPackageDto,
  type PiEcosystemQueryService,
  type PiEcosystemResourceTypeDto,
  type PiEcosystemSearchRequestDto,
  type PiEcosystemSearchResponseDto,
} from '@agent-lens/protocol'
import type { AgentLensContext } from '@agent-lens/runtime-cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    piEcosystem: PiEcosystemQueryService
  }
}

const NPM_SEARCH_ENDPOINT = 'https://registry.npmjs.org/-/v1/search'
const NPM_REGISTRY_ENDPOINT = 'https://registry.npmjs.org/'
const SEARCH_CACHE_TTL_MS = 60_000
const PACKAGE_CACHE_TTL_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 8_000
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 20
const MAX_TYPED_SEARCH_SIZE = 50
const PACKAGE_DETAIL_CONCURRENCY = 6
const MAX_SEARCH_CACHE_ENTRIES = 64
const MAX_PACKAGE_CACHE_ENTRIES = 256

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

interface NpmSearchPackage {
  name?: unknown
  version?: unknown
  description?: unknown
  keywords?: unknown
  date?: unknown
  links?: unknown
}

interface NpmSearchResult {
  total?: unknown
  objects?: unknown
}

interface NpmPackageDetails {
  resourceTypes: PiEcosystemResourceTypeDto[]
  repositoryUrl?: string | undefined
  publishedAt?: string | undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap(item => typeof item === 'string' && item.trim() ? [item.trim()] : [])
    : []
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function repositoryUrl(value: unknown): string | undefined {
  const direct = stringValue(value)
  const nested = objectValue(value)
  const candidate = direct ?? stringValue(nested?.url)
  if (!candidate) return undefined
  return candidate
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
}

function piPackageUrl(packageName: string): string {
  const path = packageName.split('/').map(segment => encodeURIComponent(segment)).join('/')
  return `https://pi.dev/packages/${path}`
}

function resourceTypesFromManifest(manifest: Record<string, unknown> | undefined): PiEcosystemResourceTypeDto[] {
  const pi = objectValue(manifest?.pi)
  if (!pi) return []
  const rows: Array<[PiEcosystemResourceTypeDto, string]> = [
    ['extension', 'extensions'],
    ['skill', 'skills'],
    ['prompt', 'prompts'],
    ['theme', 'themes'],
  ]
  return rows.flatMap(([type, field]) => {
    const value = pi[field]
    return (Array.isArray(value) && value.length > 0) || (typeof value === 'string' && value.trim())
      ? [type]
      : []
  })
}

function searchPackage(value: unknown): NpmSearchPackage | undefined {
  const row = objectValue(value)
  return objectValue(row?.package) as NpmSearchPackage | undefined
}

function packageLinks(value: unknown): Record<string, unknown> | undefined {
  return objectValue(value)
}

function validResourceType(value: unknown): value is PiEcosystemResourceTypeDto {
  return value === 'extension' || value === 'skill' || value === 'prompt' || value === 'theme'
}

function boundedLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.max(1, Math.min(MAX_LIMIT, value))
    : DEFAULT_LIMIT
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value as K | undefined
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!values.length) return []
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index]!, index)
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    () => worker(),
  ))
  return results
}

async function responseJson(response: Response, context: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${context} failed with HTTP ${response.status}`)
  }
  return response.json()
}

export class NpmPiEcosystemProvider implements PiEcosystemQueryService {
  private readonly searchCache = new Map<string, CacheEntry<PiEcosystemSearchResponseDto>>()
  private readonly lastGoodSearch = new Map<string, PiEcosystemSearchResponseDto>()
  private readonly packageCache = new Map<string, CacheEntry<NpmPackageDetails>>()

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async search(request: PiEcosystemSearchRequestDto = {}): Promise<PiEcosystemSearchResponseDto> {
    const query = request.query?.trim() ?? ''
    const type = validResourceType(request.type) ? request.type : undefined
    const limit = boundedLimit(request.limit)
    const cacheKey = JSON.stringify({ query, type: type ?? '', limit })
    const cached = this.searchCache.get(cacheKey)
    if (cached && cached.expiresAt > this.now()) return cached.value

    try {
      const value = await this.searchFresh(query, type, limit)
      setBounded(this.searchCache, cacheKey, {
        value,
        expiresAt: this.now() + SEARCH_CACHE_TTL_MS,
      }, MAX_SEARCH_CACHE_ENTRIES)
      setBounded(this.lastGoodSearch, cacheKey, value, MAX_SEARCH_CACHE_ENTRIES)
      return value
    } catch (error) {
      const lastGood = this.lastGoodSearch.get(cacheKey)
      if (lastGood) return { ...lastGood, stale: true }
      throw error
    }
  }

  private async searchFresh(
    query: string,
    type: PiEcosystemResourceTypeDto | undefined,
    limit: number,
  ): Promise<PiEcosystemSearchResponseDto> {
    const url = new URL(NPM_SEARCH_ENDPOINT)
    url.searchParams.set('text', ['keywords:pi-package', query].filter(Boolean).join(' '))
    url.searchParams.set('size', String(type ? Math.min(MAX_TYPED_SEARCH_SIZE, limit * 3) : limit))
    url.searchParams.set('from', '0')

    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const raw = await responseJson(await this.fetcher(url, {
      headers: { accept: 'application/json' },
      signal,
    }), 'npm package search')
    const result = objectValue(raw) as NpmSearchResult | undefined
    const objects = Array.isArray(result?.objects) ? result.objects : []
    const upstreamTotal = typeof result?.total === 'number' && Number.isFinite(result.total)
      ? result.total
      : objects.length

    const candidates = objects.flatMap(value => {
      const pkg = searchPackage(value)
      const packageName = stringValue(pkg?.name)
      const version = stringValue(pkg?.version)
      if (!packageName || !version) return []
      return [{ pkg, packageName, version }]
    })

    const enriched = await mapWithConcurrency(
      candidates,
      PACKAGE_DETAIL_CONCURRENCY,
      async ({ pkg, packageName, version }) => {
        const details = await this.packageDetails(packageName, version)
          .catch((): NpmPackageDetails => ({ resourceTypes: [] }))
        const links = packageLinks(pkg.links)
        const repository = details.repositoryUrl ?? stringValue(links?.repository)
        const description = stringValue(pkg.description)
        const publishedAt = stringValue(pkg.date) ?? details.publishedAt
        const item: PiEcosystemPackageDto = {
          packageSource: `npm:${packageName}`,
          packageName,
          version,
          ...(description ? { description } : {}),
          keywords: stringArray(pkg.keywords),
          resourceTypes: details.resourceTypes,
          npmUrl: stringValue(links?.npm) ?? `https://www.npmjs.com/package/${packageName}`,
          officialUrl: piPackageUrl(packageName),
          ...(repository ? { repositoryUrl: repositoryUrl(repository) ?? repository } : {}),
          installCommand: `pi install npm:${packageName}`,
          ...(publishedAt ? { publishedAt } : {}),
        }
        return item
      },
    )

    const items = enriched
      // Pi also supports conventional resource directories. Without a stable typed Catalog API,
      // only claim a resource type when the published package metadata explicitly declares it.
      .filter(item => !type || item.resourceTypes.includes(type))
      .slice(0, limit)

    return {
      query,
      ...(type ? { type } : {}),
      items,
      upstreamTotal,
      source: 'npm-registry',
      fetchedAt: new Date(this.now()).toISOString(),
      stale: false,
      meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION },
    }
  }

  private async packageDetails(packageName: string, version: string): Promise<NpmPackageDetails> {
    const cacheKey = `${packageName}\u0000${version}`
    const cached = this.packageCache.get(cacheKey)
    if (cached && cached.expiresAt > this.now()) return cached.value

    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const raw = await responseJson(await this.fetcher(`${NPM_REGISTRY_ENDPOINT}${encodeURIComponent(packageName)}`, {
      headers: { accept: 'application/json' },
      signal,
    }), `npm package metadata ${packageName}@${version}`)
    const packument = objectValue(raw)
    const versions = objectValue(packument?.versions)
    const manifest = objectValue(versions?.[version])
    const time = objectValue(packument?.time)
    const resolvedRepositoryUrl = repositoryUrl(manifest?.repository ?? packument?.repository)
    const publishedAt = stringValue(time?.[version])
    const value: NpmPackageDetails = {
      resourceTypes: resourceTypesFromManifest(manifest),
      ...(resolvedRepositoryUrl ? { repositoryUrl: resolvedRepositoryUrl } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    }
    setBounded(this.packageCache, cacheKey, {
      value,
      expiresAt: this.now() + PACKAGE_CACHE_TTL_MS,
    }, MAX_PACKAGE_CACHE_ENTRIES)
    return value
  }
}

const applyPiEcosystem = Object.assign(
  async (ctx: AgentLensContext) => {
    const service = new NpmPiEcosystemProvider()
    return ctx.provide('piEcosystem', service)
  },
  { inject: [] as string[] },
)

export const piEcosystemPlugin = applyPiEcosystem

export const piEcosystemInternals = {
  resourceTypesFromManifest,
  repositoryUrl,
  piPackageUrl,
  boundedLimit,
  setBounded,
  mapWithConcurrency,
  PACKAGE_DETAIL_CONCURRENCY,
  MAX_SEARCH_CACHE_ENTRIES,
  MAX_PACKAGE_CACHE_ENTRIES,
}
