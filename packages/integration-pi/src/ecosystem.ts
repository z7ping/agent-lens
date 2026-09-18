import {
  AGENT_LENS_PROTOCOL_VERSION,
  type PiEcosystemPackageDetailsRequestDto,
  type PiEcosystemPackageDetailsResponseDto,
  type PiEcosystemPackageDto,
  type PiEcosystemQueryService,
  type PiEcosystemResourceTypeDto,
  type PiEcosystemSearchRequestDto,
  type PiEcosystemSearchResponseDto,
  type PiEcosystemSortDto,
} from '@agent-lens/protocol'
import type { AgentLensContext } from '@agent-lens/runtime-cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    piEcosystem: PiEcosystemQueryService
  }
}

const NPM_SEARCH_ENDPOINT = 'https://registry.npmjs.org/-/v1/search'
const NPM_REGISTRY_ENDPOINT = 'https://registry.npmjs.org/'
const NPM_DOWNLOADS_ENDPOINT = 'https://api.npmjs.org/downloads/point/last-month'
const SEARCH_CACHE_TTL_MS = 60_000
const PACKAGE_CACHE_TTL_MS = 5 * 60_000
const DOWNLOAD_CACHE_TTL_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 8_000
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 20
const SEARCH_PAGE_SIZE = 250
const MAX_CATALOG_CANDIDATES = 1_000
const TYPE_FILTER_BATCH_SIZE = 20
const PACKAGE_DETAIL_CONCURRENCY = 6
const DOWNLOAD_BATCH_SIZE = 128
const MAX_SEARCH_CACHE_ENTRIES = 64
const MAX_PACKAGE_CACHE_ENTRIES = 256
const MAX_DOWNLOAD_CACHE_ENTRIES = 2_048

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
}

interface NpmPackageCandidate {
  pkg: NpmSearchPackage
  packageName: string
  version: string
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

function validSort(value: unknown): value is PiEcosystemSortDto {
  return value === 'downloads' || value === 'recent'
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

function publishedTimestamp(candidate: NpmPackageCandidate): number {
  const value = candidate.publishedAt ? Date.parse(candidate.publishedAt) : Number.NaN
  return Number.isFinite(value) ? value : 0
}

function sortCandidates(
  candidates: NpmPackageCandidate[],
  downloads: Map<string, number>,
  sort: PiEcosystemSortDto,
): NpmPackageCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftDownloads = downloads.get(left.packageName) ?? -1
    const rightDownloads = downloads.get(right.packageName) ?? -1
    if (sort === 'downloads') {
      return rightDownloads - leftDownloads
        || publishedTimestamp(right) - publishedTimestamp(left)
        || left.packageName.localeCompare(right.packageName)
    }
    return publishedTimestamp(right) - publishedTimestamp(left)
      || rightDownloads - leftDownloads
      || left.packageName.localeCompare(right.packageName)
  })
}

function packageDto(
  candidate: NpmPackageCandidate,
  monthlyDownloads: number | undefined,
  details?: NpmPackageDetails,
): PiEcosystemPackageDto {
  const links = packageLinks(candidate.pkg.links)
  const repository = details?.repositoryUrl ?? stringValue(links?.repository)
  const description = stringValue(candidate.pkg.description)
  return {
    packageSource: `npm:${candidate.packageName}`,
    packageName: candidate.packageName,
    version: candidate.version,
    ...(description ? { description } : {}),
    keywords: stringArray(candidate.pkg.keywords),
    resourceTypes: details?.resourceTypes ?? [],
    ...(monthlyDownloads !== undefined ? { monthlyDownloads } : {}),
    npmUrl: stringValue(links?.npm) ?? `https://www.npmjs.com/package/${candidate.packageName}`,
    officialUrl: piPackageUrl(candidate.packageName),
    ...(repository ? { repositoryUrl: repositoryUrl(repository) ?? repository } : {}),
    installCommand: `pi install npm:${candidate.packageName}`,
    ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}),
  }
}

function downloadCount(value: unknown): number | undefined {
  const row = objectValue(value)
  const downloads = row?.downloads
  return typeof downloads === 'number' && Number.isFinite(downloads) && downloads >= 0
    ? downloads
    : undefined
}

export class NpmPiEcosystemProvider implements PiEcosystemQueryService {
  private readonly searchCache = new Map<string, CacheEntry<PiEcosystemSearchResponseDto>>()
  private readonly lastGoodSearch = new Map<string, PiEcosystemSearchResponseDto>()
  private readonly searchInFlight = new Map<string, Promise<PiEcosystemSearchResponseDto>>()
  private readonly packageCache = new Map<string, CacheEntry<NpmPackageDetails>>()
  private readonly packageInFlight = new Map<string, Promise<NpmPackageDetails>>()
  private readonly downloadCache = new Map<string, CacheEntry<number | undefined>>()

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async search(request: PiEcosystemSearchRequestDto = {}): Promise<PiEcosystemSearchResponseDto> {
    const query = request.query?.trim() ?? ''
    const type = validResourceType(request.type) ? request.type : undefined
    const sort = validSort(request.sort) ? request.sort : 'downloads'
    const limit = boundedLimit(request.limit)
    const cacheKey = JSON.stringify({ query, type: type ?? '', sort, limit })
    const cached = this.searchCache.get(cacheKey)
    if (cached && cached.expiresAt > this.now()) return cached.value

    const existing = this.searchInFlight.get(cacheKey)
    if (existing) return existing

    let pending!: Promise<PiEcosystemSearchResponseDto>
    pending = (async () => {
      try {
        const value = await this.searchFresh(query, type, sort, limit)
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
    })().finally(() => {
      if (this.searchInFlight.get(cacheKey) === pending) this.searchInFlight.delete(cacheKey)
    })
    this.searchInFlight.set(cacheKey, pending)
    return pending
  }

  async packageDetails(request: PiEcosystemPackageDetailsRequestDto): Promise<PiEcosystemPackageDetailsResponseDto> {
    const packageName = request.packageName.trim()
    const version = request.version.trim()
    if (!packageName || !version) throw new Error('Pi package name and version are required')
    const details = await this.packageDetailsInternal(packageName, version)
    return {
      packageSource: `npm:${packageName}`,
      packageName,
      version,
      resourceTypes: details.resourceTypes,
      ...(details.repositoryUrl ? { repositoryUrl: details.repositoryUrl } : {}),
    }
  }

  private async searchFresh(
    query: string,
    type: PiEcosystemResourceTypeDto | undefined,
    sort: PiEcosystemSortDto,
    limit: number,
  ): Promise<PiEcosystemSearchResponseDto> {
    const { candidates, upstreamTotal } = await this.searchCandidates(query)
    const downloads = await this.monthlyDownloads(candidates.map(candidate => candidate.packageName))
    const ranked = sortCandidates(candidates, downloads, sort)

    let selected: Array<{ candidate: NpmPackageCandidate; details?: NpmPackageDetails }> = []
    if (type) {
      for (let offset = 0; offset < ranked.length && selected.length < limit; offset += TYPE_FILTER_BATCH_SIZE) {
        const batch = ranked.slice(offset, offset + TYPE_FILTER_BATCH_SIZE)
        const detailed = await mapWithConcurrency(
          batch,
          PACKAGE_DETAIL_CONCURRENCY,
          async candidate => ({
            candidate,
            details: await this.packageDetailsInternal(candidate.packageName, candidate.version)
              .catch((): NpmPackageDetails => ({ resourceTypes: [] })),
          }),
        )
        selected.push(...detailed.filter(item => item.details.resourceTypes.includes(type)))
      }
      selected = selected.slice(0, limit)
    } else {
      selected = ranked.slice(0, limit).map(candidate => ({ candidate }))
    }

    return {
      query,
      ...(type ? { type } : {}),
      sort,
      items: selected.map(({ candidate, details }) =>
        packageDto(candidate, downloads.get(candidate.packageName), details)),
      upstreamTotal,
      source: 'npm-registry',
      fetchedAt: new Date(this.now()).toISOString(),
      stale: false,
      meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION },
    }
  }

  private async searchCandidates(query: string): Promise<{
    candidates: NpmPackageCandidate[]
    upstreamTotal: number
  }> {
    const candidates = new Map<string, NpmPackageCandidate>()
    let upstreamTotal = 0

    for (let from = 0; from < MAX_CATALOG_CANDIDATES; from += SEARCH_PAGE_SIZE) {
      const url = new URL(NPM_SEARCH_ENDPOINT)
      url.searchParams.set('text', ['keywords:pi-package', query].filter(Boolean).join(' '))
      url.searchParams.set('size', String(Math.min(SEARCH_PAGE_SIZE, MAX_CATALOG_CANDIDATES - from)))
      url.searchParams.set('from', String(from))

      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const raw = await responseJson(await this.fetcher(url, {
        headers: { accept: 'application/json' },
        signal,
      }), 'npm package search')
      const result = objectValue(raw) as NpmSearchResult | undefined
      const objects = Array.isArray(result?.objects) ? result.objects : []
      if (from === 0) {
        upstreamTotal = typeof result?.total === 'number' && Number.isFinite(result.total)
          ? result.total
          : objects.length
      }

      for (const value of objects) {
        const pkg = searchPackage(value)
        const packageName = stringValue(pkg?.name)
        const version = stringValue(pkg?.version)
        if (!packageName || !version || candidates.has(packageName)) continue
        candidates.set(packageName, {
          pkg,
          packageName,
          version,
          ...(stringValue(pkg?.date) ? { publishedAt: stringValue(pkg?.date) } : {}),
        })
      }

      if (!objects.length || from + objects.length >= upstreamTotal) break
    }

    return {
      candidates: [...candidates.values()],
      upstreamTotal,
    }
  }

  private async monthlyDownloads(packageNames: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>()
    const missing: string[] = []
    for (const packageName of packageNames) {
      const cached = this.downloadCache.get(packageName)
      if (cached && cached.expiresAt > this.now()) {
        if (cached.value !== undefined) result.set(packageName, cached.value)
      } else {
        missing.push(packageName)
      }
    }

    const batches: string[][] = []
    for (let offset = 0; offset < missing.length; offset += DOWNLOAD_BATCH_SIZE) {
      batches.push(missing.slice(offset, offset + DOWNLOAD_BATCH_SIZE))
    }

    await Promise.all(batches.map(async batch => {
      const encodedPackages = batch.map(packageName => encodeURIComponent(packageName)).join(',')
      try {
        const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        const raw = await responseJson(await this.fetcher(`${NPM_DOWNLOADS_ENDPOINT}/${encodedPackages}`, {
          headers: { accept: 'application/json' },
          signal,
        }), 'npm download counts')
        const root = objectValue(raw)

        if (batch.length === 1) {
          const packageName = batch[0]!
          const count = downloadCount(root)
          setBounded(this.downloadCache, packageName, {
            value: count,
            expiresAt: this.now() + DOWNLOAD_CACHE_TTL_MS,
          }, MAX_DOWNLOAD_CACHE_ENTRIES)
          if (count !== undefined) result.set(packageName, count)
          return
        }

        for (const packageName of batch) {
          const count = downloadCount(root?.[packageName])
          setBounded(this.downloadCache, packageName, {
            value: count,
            expiresAt: this.now() + DOWNLOAD_CACHE_TTL_MS,
          }, MAX_DOWNLOAD_CACHE_ENTRIES)
          if (count !== undefined) result.set(packageName, count)
        }
      } catch {
        // Download counts are useful ranking metadata, but their temporary absence must not make
        // the Pi catalog unavailable. Unknown counts sort after known counts.
      }
    }))

    return result
  }

  private async packageDetailsInternal(packageName: string, version: string): Promise<NpmPackageDetails> {
    const cacheKey = `${packageName}\u0000${version}`
    const cached = this.packageCache.get(cacheKey)
    if (cached && cached.expiresAt > this.now()) return cached.value

    const existing = this.packageInFlight.get(cacheKey)
    if (existing) return existing

    let pending!: Promise<NpmPackageDetails>
    pending = (async () => {
      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const raw = await responseJson(await this.fetcher(
        `${NPM_REGISTRY_ENDPOINT}${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
        {
          headers: { accept: 'application/json' },
          signal,
        },
      ), `npm package metadata ${packageName}@${version}`)
      const manifest = objectValue(raw)
      const resolvedRepositoryUrl = repositoryUrl(manifest?.repository)
      const value: NpmPackageDetails = {
        resourceTypes: resourceTypesFromManifest(manifest),
        ...(resolvedRepositoryUrl ? { repositoryUrl: resolvedRepositoryUrl } : {}),
      }
      setBounded(this.packageCache, cacheKey, {
        value,
        expiresAt: this.now() + PACKAGE_CACHE_TTL_MS,
      }, MAX_PACKAGE_CACHE_ENTRIES)
      return value
    })().finally(() => {
      if (this.packageInFlight.get(cacheKey) === pending) this.packageInFlight.delete(cacheKey)
    })
    this.packageInFlight.set(cacheKey, pending)
    return pending
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
  validSort,
  setBounded,
  mapWithConcurrency,
  sortCandidates,
  downloadCount,
  PACKAGE_DETAIL_CONCURRENCY,
  TYPE_FILTER_BATCH_SIZE,
  DOWNLOAD_BATCH_SIZE,
  MAX_SEARCH_CACHE_ENTRIES,
  MAX_PACKAGE_CACHE_ENTRIES,
  MAX_DOWNLOAD_CACHE_ENTRIES,
}
