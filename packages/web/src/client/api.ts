import type {
  AgentOverviewResponseDto,
  FacetResponseDto,
  HealthResponseDto,
  LiveUpdateEventDto,
  ReviewResponseDto,
  ReviewSessionDetailDto,
  SessionRelationshipResponseDto,
  ToolAssetUsageResponseDto,
} from '@agent-lens/protocol'

export interface QueryFilters {
  sourceId: string
  projectId: string
  range: 'today' | '7d' | '30d' | 'all'
}

export interface ReviewFilters extends QueryFilters {
  status: 'all' | 'with-errors' | 'clean'
  search: string
}

function rangeStart(range: QueryFilters['range']): string | undefined {
  if (range === 'all') return undefined
  const date = new Date()
  if (range === 'today') date.setHours(0, 0, 0, 0)
  else date.setDate(date.getDate() - (range === '7d' ? 7 : 30))
  return date.toISOString()
}

function appendFilters(params: URLSearchParams, filters: QueryFilters): void {
  if (filters.sourceId) params.set('sourceId', filters.sourceId)
  if (filters.projectId) params.set('projectId', filters.projectId)
  const from = rangeStart(filters.range)
  if (from) params.set('from', from)
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`AgentLens API ${response.status}: ${path}`)
  return response.json() as Promise<T>
}

export class AgentLensApi {
  health(): Promise<HealthResponseDto> { return getJson('/api/v1/health') }
  facets(): Promise<FacetResponseDto> { return getJson('/api/v1/facets') }
  agents(): Promise<AgentOverviewResponseDto> { return getJson('/api/v1/agents') }

  review(filters: ReviewFilters, limit = 40): Promise<ReviewResponseDto> {
    const params = new URLSearchParams()
    appendFilters(params, filters)
    if (filters.status !== 'all') params.set('status', filters.status)
    if (filters.search.trim()) params.set('search', filters.search.trim())
    params.set('limit', String(Math.max(1, Math.min(limit, 500))))
    return getJson(`/api/v1/review?${params}`)
  }

  reviewDetail(id: string, options: { cursor?: string; limit?: number } = {}): Promise<ReviewSessionDetailDto> {
    const params = new URLSearchParams()
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.limit !== undefined) params.set('limit', String(Math.max(1, Math.min(options.limit, 100))))
    const query = params.toString()
    return getJson(`/api/v1/review/${encodeURIComponent(id)}${query ? `?${query}` : ''}`)
  }

  relationships(id: string): Promise<SessionRelationshipResponseDto> {
    return getJson(`/api/v1/relationships?logicalSessionId=${encodeURIComponent(id)}`)
  }

  usage(filters: QueryFilters): Promise<ToolAssetUsageResponseDto> {
    const params = new URLSearchParams()
    appendFilters(params, filters)
    params.set('limit', '500')
    return getJson(`/api/v1/usage?${params}`)
  }

  subscribe(onEvent: (event: LiveUpdateEventDto) => void, onConnection: (connected: boolean) => void): () => void {
    const source = new EventSource('/api/v1/events')
    source.onopen = () => onConnection(true)
    source.onerror = () => onConnection(false)
    source.addEventListener('observation', raw => {
      try { onEvent(JSON.parse((raw as MessageEvent<string>).data) as LiveUpdateEventDto) } catch { /* ignore malformed frame */ }
    })
    return () => { source.close(); onConnection(false) }
  }
}
