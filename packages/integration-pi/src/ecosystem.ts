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
      this.searchCache.set(cacheKey, {
        value,
        expiresAt: this.now() + SEARCH_CACHE_TTL_MS,
      })
      this.lastGoodSearch.set(cacheKey, value)
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

    const enriched = await Promise.all(candidates.map(async ({ pkg, packageName, version }) => {
      const details = await this.packageDetails(packageName).catch(() => ({ resourceTypes: [] }))
      const links = packageLinks(pkg.links)
      const repository = details.repositoryUrl ?? stringValue(links?.repository)
      const item: PiEcosystemPackageDto = {
        packageSource: `npm:${packageName}`,
        packageName,
        version,
        ...(stringValue(pkg.description) ? { description: stringValue(pkg.description) } : {}),
        keywords: stringArray(pkg.keywords),
        resourceTypes: details.resourceTypes,
        npmUrl: stringValue(links?.npm) ?? `https://www.npmjs.com/package/${packageName}`,
        officialUrl: `https://pi.dev/packages?name=${encodeURIComponent(packageName)}`,
        ...(repository ? { repositoryUrl: repositoryUrl(repository) ?? repository } : {}),
        installCommand: `pi install npm:${packageName}`,
        ...(stringValue(pkg.date) ?? details.publishedAt
          ? { publishedAt: stringValue(pkg.date) ?? details.publishedAt }
          : {}),
      }
      return item
    }))

    const items = enriched
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

  private async packageDetails(packageName: string): Promise<NpmPackageDetails> {
    const cached = this.packageCache.get(packageName)
    if (cached && cached.expiresAt > this.now()) return cached.value

    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const raw = await responseJson(await this.fetcher(`${NPM_REGISTRY_ENDPOINT}${encodeURIComponent(packageName)}`, {
      headers: { accept: 'application/json' },
      signal,
    }), `npm package metadata ${packageName}`)
    const packument = objectValue(raw)
    const distTags = objectValue(packument?.['dist-tags'])
    const latest = stringValue(distTags?.latest)
    const versions = objectValue(packument?.versions)
    const manifest = latest ? objectValue(versions?.[latest]) : undefined
    const time = objectValue(packument?.time)
    const value: NpmPackageDetails = {
      resourceTypes: resourceTypesFromManifest(manifest),
      ...(repositoryUrl(manifest?.repository ?? packument?.repository)
        ? { repositoryUrl: repositoryUrl(manifest?.repository ?? packument?.repository) }
        : {}),
      ...(latest && stringValue(time?.[latest]) ? { publishedAt: stringValue(time?.[latest]) } : {}),
    }
    this.packageCache.set(packageName, {
      value,
      expiresAt: this.now() + PACKAGE_CACHE_TTL_MS,
    })
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
  boundedLimit,
}
