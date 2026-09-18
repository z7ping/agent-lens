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

const PI_CATALOG_ENDPOINT = 'https://pi.dev/packages'
const NPM_REGISTRY_ENDPOINT = 'https://registry.npmjs.org/'
const CATALOG_CACHE_TTL_MS = 10 * 60_000
const PACKAGE_CACHE_TTL_MS = 5 * 60_000
const CATALOG_TIMEOUT_MS = 15_000
const PACKAGE_TIMEOUT_MS = 8_000
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 20
const MAX_SEARCH_CACHE_ENTRIES = 64
const MAX_PACKAGE_CACHE_ENTRIES = 256

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

interface NpmPackageDetails {
  resourceTypes: PiEcosystemResourceTypeDto[]
  repositoryUrl?: string | undefined
}

interface PiCatalogParseResult {
  items: PiEcosystemPackageDto[]
  total: number
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '')
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`))
  return match?.[1] === undefined ? undefined : decodeHtmlEntities(match[1])
}

function finiteNonNegative(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function validResourceType(value: string): value is PiEcosystemResourceTypeDto {
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

function packageVersionFromBody(body: string): string | undefined {
  const decoded = decodeHtmlEntities(body)
  const match = decoded.match(/[?&]package-version=([^&#"']+)/)
  if (!match?.[1]) return undefined
  try {
    return decodeURIComponent(match[1]).trim() || undefined
  } catch {
    return match[1].trim() || undefined
  }
}

function absolutePiUrl(path: string | undefined, packageName: string): string {
  if (!path) return `${PI_CATALOG_ENDPOINT}/${encodeURIComponent(packageName)}`
  try {
    return new URL(decodeHtmlEntities(path), 'https://pi.dev').toString()
  } catch {
    return `${PI_CATALOG_ENDPOINT}/${encodeURIComponent(packageName)}`
  }
}

export function parsePiCatalogHtml(html: string): PiCatalogParseResult {
  const cards = [...html.matchAll(/<article[^>]*data-package-card="true"[^>]*>/g)]
  const items: PiEcosystemPackageDto[] = []

  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index]!
    const tag = card[0]
    const bodyStart = (card.index ?? 0) + tag.length
    const bodyEnd = index + 1 < cards.length ? (cards[index + 1]!.index ?? html.length) : html.length
    const body = html.slice(bodyStart, bodyEnd)

    const packageName = attribute(tag, 'data-package-name')
    if (!packageName) continue

    const resourceTypes = (attribute(tag, 'data-package-types') ?? '')
      .split(/\s+/)
      .filter(validResourceType)
    const monthlyDownloads = finiteNonNegative(attribute(tag, 'data-package-downloads'))
    const publishedAtMs = finiteNonNegative(attribute(tag, 'data-package-date'))
    const descriptionMatch = body.match(/<p class="packages-desc">([\s\S]*?)<\/p>/)
    const npmMatch = body.match(/href="(https:\/\/www\.npmjs\.com\/package\/[^"]+)"/)
    const repositoryMatch = body.match(/href="(https:\/\/github\.com\/[^"]+)"/)
    const pageMatch = body.match(/class="packages-name"><a href="([^"]+)"/)
    const version = packageVersionFromBody(body)
    const description = descriptionMatch
      ? decodeHtmlEntities(stripTags(descriptionMatch[1] ?? '')).trim()
      : ''

    items.push({
      packageSource: `npm:${packageName}`,
      packageName,
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
      keywords: [],
      resourceTypes,
      ...(monthlyDownloads !== undefined ? { monthlyDownloads } : {}),
      npmUrl: npmMatch?.[1]
        ? decodeHtmlEntities(npmMatch[1])
        : `https://www.npmjs.com/package/${packageName}`,
      officialUrl: absolutePiUrl(pageMatch?.[1], packageName),
      ...(repositoryMatch?.[1] ? { repositoryUrl: decodeHtmlEntities(repositoryMatch[1]) } : {}),
      installCommand: `pi install npm:${packageName}`,
      ...(publishedAtMs !== undefined && publishedAtMs > 0
        ? { publishedAt: new Date(publishedAtMs).toISOString() }
        : {}),
    })
  }

  const totalMatch = html.match(/class="packages-count">\s*\d+\s*-\s*\d+\s*\/\s*(\d+)/)
  const total = totalMatch?.[1] ? Number(totalMatch[1]) : items.length

  return {
    items,
    total: Number.isSafeInteger(total) && total >= 0 ? total : items.length,
  }
}

function catalogUrl(
  query: string,
  type: PiEcosystemResourceTypeDto | undefined,
  sort: PiEcosystemSortDto,
): string {
  const url = new URL(PI_CATALOG_ENDPOINT)
  if (query) url.searchParams.set('name', query)
  if (type) url.searchParams.set('type', type)
  if (sort === 'recent') url.searchParams.set('sort', 'recent')
  return url.toString()
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

async function responseText(response: Response, context: string): Promise<string> {
  if (!response.ok) throw new Error(`${context} failed with HTTP ${response.status}`)
  return response.text()
}

async function responseJson(response: Response, context: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${context} failed with HTTP ${response.status}`)
  return response.json()
}

export class PiDevEcosystemProvider implements PiEcosystemQueryService {
  private readonly searchCache = new Map<string, CacheEntry<PiEcosystemSearchResponseDto>>()
  private readonly lastGoodSearch = new Map<string, PiEcosystemSearchResponseDto>()
  private readonly searchInFlight = new Map<string, Promise<PiEcosystemSearchResponseDto>>()
  private readonly packageCache = new Map<string, CacheEntry<NpmPackageDetails>>()
  private readonly packageInFlight = new Map<string, Promise<NpmPackageDetails>>()

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async search(request: PiEcosystemSearchRequestDto = {}): Promise<PiEcosystemSearchResponseDto> {
    const query = request.query?.trim() ?? ''
    const type = request.type && validResourceType(request.type) ? request.type : undefined
    const sort = validSort(request.sort) ? request.sort : 'downloads'
    const limit = boundedLimit(request.limit)
    const cacheKey = JSON.stringify({ query, type: type ?? '', sort, limit })
    const cached = this.searchCache.get(cacheKey)
    if (cached && cached.expiresAt > this.now()) return cached.value

    const existing = this.searchInFlight.get(cacheKey)
    if (existing) return existing

    let pending!: Promise<PiEcosystemSearchResponseDto>
    pending = this.searchFresh(query, type, sort, limit)
      .then(value => {
        setBounded(this.searchCache, cacheKey, {
          value,
          expiresAt: this.now() + CATALOG_CACHE_TTL_MS,
        }, MAX_SEARCH_CACHE_ENTRIES)
        setBounded(this.lastGoodSearch, cacheKey, value, MAX_SEARCH_CACHE_ENTRIES)
        return value
      })
      .catch(error => {
        const lastGood = this.lastGoodSearch.get(cacheKey)
        if (lastGood) return { ...lastGood, stale: true }
        throw error
      })
      .finally(() => {
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
    const url = catalogUrl(query, type, sort)
    let html: string
    try {
      html = await responseText(await this.fetcher(url, {
        headers: { accept: 'text/html' },
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      }), 'Pi Package Catalog')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Pi Package Catalog unavailable: ${message}`)
    }

    const parsed = parsePiCatalogHtml(html)
    if (!parsed.items.length && !query && !type) {
      throw new Error('Pi Package Catalog returned no packages')
    }

    return {
      query,
      ...(type ? { type } : {}),
      sort,
      items: parsed.items.slice(0, limit),
      upstreamTotal: parsed.total,
      source: 'pi-dev',
      fetchedAt: new Date(this.now()).toISOString(),
      stale: false,
      meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION },
    }
  }

  private async packageDetailsInternal(packageName: string, version: string): Promise<NpmPackageDetails> {
    const cacheKey = `${packageName}\u0000${version}`
    const cached = this.packageCache.get(cacheKey)
    if (cached && cached.expiresAt > this.now()) return cached.value

    const existing = this.packageInFlight.get(cacheKey)
    if (existing) return existing

    let pending!: Promise<NpmPackageDetails>
    pending = (async () => {
      const raw = await responseJson(await this.fetcher(
        `${NPM_REGISTRY_ENDPOINT}${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
        {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(PACKAGE_TIMEOUT_MS),
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

// Compatibility export for tests/extensions that referenced the previous implementation name.
export { PiDevEcosystemProvider as NpmPiEcosystemProvider }

const applyPiEcosystem = Object.assign(
  async (ctx: AgentLensContext) => {
    const service = new PiDevEcosystemProvider()
    return ctx.provide('piEcosystem', service)
  },
  { inject: [] as string[] },
)

export const piEcosystemPlugin = applyPiEcosystem

export const piEcosystemInternals = {
  parsePiCatalogHtml,
  catalogUrl,
  resourceTypesFromManifest,
  repositoryUrl,
  validSort,
  boundedLimit,
  setBounded,
  CATALOG_CACHE_TTL_MS,
  CATALOG_TIMEOUT_MS,
  MAX_SEARCH_CACHE_ENTRIES,
  MAX_PACKAGE_CACHE_ENTRIES,
}
