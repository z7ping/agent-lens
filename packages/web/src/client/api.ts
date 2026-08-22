import type {
  AgentOverviewResponseDto,
  BackupCreateRequestDto,
  BackupOverviewResponseDto,
  BackupRestorePreviewResponseDto,
  BackupSnapshotResponseDto,
  BackupVerifyResponseDto,
  FacetResponseDto,
  HealthResponseDto,
  LiveUpdateEventDto,
  ReviewDetailDirection,
  ReviewDetailFilter,
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

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  try {
    const response = await fetch(path, {
      ...init,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
    })
    if (!response.ok) {
      let detail = ''
      try {
        const body = await response.json() as { message?: unknown }
        if (typeof body.message === 'string' && body.message) detail = `：${body.message}`
      } catch { /* non-json error */ }
      throw new Error(`AgentLens 接口请求失败（状态码 ${response.status}）${detail}：${path}`)
    }
    return response.json() as Promise<T>
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('AgentLens 接口请求失败')) throw error
    throw new Error('AgentLens 接口请求失败，请检查运行状态和连接。')
  }
}

async function requestBlob(path: string): Promise<Blob> {
  try {
    const response = await fetch(path, { headers: { accept: 'application/vnd.agentlens.backup' } })
    if (!response.ok) throw new Error(`AgentLens 接口请求失败（状态码 ${response.status}）：${path}`)
    return response.blob()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('AgentLens 接口请求失败')) throw error
    throw new Error('备份包导出失败，请检查运行状态和连接。')
  }
}

export class AgentLensApi {
  health(): Promise<HealthResponseDto> { return requestJson('/api/v1/health') }
  facets(): Promise<FacetResponseDto> { return requestJson('/api/v1/facets') }
  agents(): Promise<AgentOverviewResponseDto> { return requestJson('/api/v1/agents') }

  review(filters: ReviewFilters, limit = 40): Promise<ReviewResponseDto> {
    const params = new URLSearchParams()
    appendFilters(params, filters)
    if (filters.status !== 'all') params.set('status', filters.status)
    if (filters.search.trim()) params.set('search', filters.search.trim())
    params.set('limit', String(Math.max(1, Math.min(limit, 500))))
    return requestJson(`/api/v1/review?${params}`)
  }

  reviewDetail(
    id: string,
    options: {
      cursor?: string
      limit?: number
      direction?: ReviewDetailDirection
      filter?: ReviewDetailFilter
    } = {},
  ): Promise<ReviewSessionDetailDto> {
    const params = new URLSearchParams()
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.direction) params.set('direction', options.direction)
    if (options.filter && options.filter !== 'all') params.set('filter', options.filter)
    if (options.limit !== undefined) params.set('limit', String(Math.max(1, Math.min(options.limit, 100))))
    const query = params.toString()
    return requestJson(`/api/v1/review/${encodeURIComponent(id)}${query ? `?${query}` : ''}`)
  }

  relationships(id: string): Promise<SessionRelationshipResponseDto> {
    return requestJson(`/api/v1/relationships?logicalSessionId=${encodeURIComponent(id)}`)
  }

  usage(filters: QueryFilters): Promise<ToolAssetUsageResponseDto> {
    const params = new URLSearchParams()
    appendFilters(params, filters)
    params.set('limit', '500')
    return requestJson(`/api/v1/usage?${params}`)
  }

  backupOverview(): Promise<BackupOverviewResponseDto> {
    return requestJson('/api/v1/backups')
  }

  backupSnapshot(id: string): Promise<BackupSnapshotResponseDto> {
    return requestJson(`/api/v1/backups/${encodeURIComponent(id)}`)
  }

  createBackup(input: BackupCreateRequestDto): Promise<BackupSnapshotResponseDto> {
    return requestJson('/api/v1/backups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  }

  verifyBackup(id: string): Promise<BackupVerifyResponseDto> {
    return requestJson(`/api/v1/backups/${encodeURIComponent(id)}/verify`, { method: 'POST' })
  }

  backupRestorePreview(id: string): Promise<BackupRestorePreviewResponseDto> {
    return requestJson(`/api/v1/backups/${encodeURIComponent(id)}/restore-preview`)
  }

  exportBackup(id: string): Promise<Blob> {
    return requestBlob(`/api/v1/backups/${encodeURIComponent(id)}/export`)
  }

  importBackup(file: Blob): Promise<BackupSnapshotResponseDto> {
    return requestJson('/api/v1/backups/import', {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.agentlens.backup' },
      body: file,
    })
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
