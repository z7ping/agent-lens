import {
  parseLiveUpdateEvent,
  type AgentOverviewResponseDto,
  type BackupCreateRequestDto,
  type BackupOverviewResponseDto,
  type BackupRestorePreviewResponseDto,
  type BackupSnapshotResponseDto,
  type BackupSnapshotSummaryDto,
  type BackupVerifyResponseDto,
  type CapturePolicyResponseDto,
  type FacetResponseDto,
  type HealthResponseDto,
  type InsightsResponseDto,
  type LiveUpdateEventDto,
  type ReviewDetailDirection,
  type ReviewDetailFilter,
  type ReviewResponseDto,
  type ReviewSessionDetailDto,
  type SessionRelationshipResponseDto,
  type SourceRecordResponseDto,
  type ToolAssetUsageResponseDto,
} from '@agent-lens/protocol'

export const LIVE_RECONNECTED_EVENT = 'agent-lens:live-reconnected'

export interface QueryFilters {
  sourceIds: string[]
  projectId: string
  range: 'today' | '7d' | '30d' | 'all'
}

export interface ReviewFilters extends QueryFilters {
  status: 'all' | 'with-errors' | 'clean'
  search: string
}

let agentsInFlight: Promise<AgentOverviewResponseDto> | null = null
let backupOverviewInFlight: Promise<BackupOverviewResponseDto> | null = null
let backupOverviewCache: BackupOverviewResponseDto | null = null
let reuseBackupOverviewOnce = false

function rangeStart(range: QueryFilters['range']): string | undefined {
  if (range === 'all') return undefined
  const date = new Date()
  if (range === 'today') date.setHours(0, 0, 0, 0)
  else date.setDate(date.getDate() - (range === '7d' ? 7 : 30))
  return date.toISOString()
}

function appendFilters(params: URLSearchParams, filters: QueryFilters): void {
  for (const sourceId of filters.sourceIds) params.append('sourceId', sourceId)
  if (filters.projectId) params.set('projectId', filters.projectId)
  const from = rangeStart(filters.range)
  if (from) params.set('from', from)
}

function responseErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const message = Reflect.get(value, 'message')
  return typeof message === 'string' && message ? message : undefined
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
        const message = responseErrorMessage(await response.json())
        if (message) detail = `：${message}`
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

function backupSnapshotSummary(response: BackupSnapshotResponseDto): BackupSnapshotSummaryDto {
  const sourceIds = new Set<string>()
  let totalBytes = 0
  for (const file of response.snapshot.files) {
    sourceIds.add(file.sourceId)
    totalBytes += file.size
  }
  for (const item of response.snapshot.excluded) sourceIds.add(item.sourceId)
  return {
    id: response.snapshot.id,
    createdAt: response.snapshot.createdAt,
    sourceIds: [...sourceIds].sort(),
    fileCount: response.snapshot.files.length,
    excludedCount: response.snapshot.excluded.length,
    totalBytes,
    manifestSha256: response.snapshot.manifestSha256,
  }
}

function rememberBackupSnapshot(response: BackupSnapshotResponseDto): void {
  if (!backupOverviewCache) return
  const summary = backupSnapshotSummary(response)
  backupOverviewCache = {
    ...backupOverviewCache,
    snapshots: [summary, ...backupOverviewCache.snapshots.filter(item => item.id !== summary.id)]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    meta: { ...backupOverviewCache.meta, generatedAt: response.meta.generatedAt },
  }
  reuseBackupOverviewOnce = true
}

export class AgentLensApi {
  private backupOverviewLoaded = false

  health(): Promise<HealthResponseDto> { return requestJson('/api/v1/health') }
  facets(): Promise<FacetResponseDto> { return requestJson('/api/v1/facets') }
  agents(): Promise<AgentOverviewResponseDto> {
    if (agentsInFlight) return agentsInFlight
    const pending = requestJson<AgentOverviewResponseDto>('/api/v1/agents')
    let shared: Promise<AgentOverviewResponseDto>
    shared = pending.then(
      result => {
        if (agentsInFlight === shared) agentsInFlight = null
        return result
      },
      error => {
        if (agentsInFlight === shared) agentsInFlight = null
        throw error
      },
    )
    agentsInFlight = shared
    return shared
  }
  capturePolicy(): Promise<CapturePolicyResponseDto> { return requestJson('/api/v1/capture-policy/sources') }

  updateCaptureSources(enabledSources: readonly string[]): Promise<CapturePolicyResponseDto> {
    return requestJson('/api/v1/capture-policy/sources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabledSources }),
    })
  }

  review(filters: ReviewFilters, limit = 40, cursor?: string, signal?: AbortSignal): Promise<ReviewResponseDto> {
    const params = new URLSearchParams()
    appendFilters(params, filters)
    if (filters.status !== 'all') params.set('status', filters.status)
    if (filters.search.trim()) params.set('search', filters.search.trim())
    if (cursor) params.set('cursor', cursor)
    params.set('limit', String(Math.max(1, Math.min(limit, 500))))
    return requestJson<ReviewResponseDto>(`/api/v1/review?${params}`, signal ? { signal } : {})
  }

  reviewDetail(
    id: string,
    options: {
      cursor?: string
      ordinal?: number
      limit?: number
      direction?: ReviewDetailDirection
      filter?: ReviewDetailFilter
    } = {},
  ): Promise<ReviewSessionDetailDto> {
    const params = new URLSearchParams()
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.ordinal !== undefined) params.set('ordinal', String(options.ordinal))
    if (options.direction) params.set('direction', options.direction)
    if (options.filter && options.filter !== 'all') params.set('filter', options.filter)
    if (options.limit !== undefined) params.set('limit', String(Math.max(1, Math.min(options.limit, 100))))
    const query = params.toString()
    return requestJson<ReviewSessionDetailDto>(`/api/v1/review/${encodeURIComponent(id)}${query ? `?${query}` : ''}`)
  }

  relationships(id: string): Promise<SessionRelationshipResponseDto> {
    return requestJson(`/api/v1/relationships?logicalSessionId=${encodeURIComponent(id)}`)
  }

  sourceRecord(id: string): Promise<SourceRecordResponseDto> {
    return requestJson(`/api/v1/source-records/${encodeURIComponent(id)}`)
  }

  usage(filters: QueryFilters): Promise<ToolAssetUsageResponseDto> {
    const params = new URLSearchParams()
    appendFilters(params, filters)
    params.set('limit', '500')
    return requestJson(`/api/v1/usage?${params}`)
  }

  usageDetail(filters: QueryFilters, toolName: string): Promise<ToolAssetUsageResponseDto> {
    const params = new URLSearchParams()
    appendFilters(params, filters)
    params.set('toolName', toolName)
    params.set('limit', '1')
    return requestJson(`/api/v1/usage/detail?${params}`)
  }

  insights(filters: QueryFilters): Promise<InsightsResponseDto> {
    const params = new URLSearchParams()
    appendFilters(params, filters)
    return requestJson(`/api/v1/insights?${params}`)
  }

  backupOverview(): Promise<BackupOverviewResponseDto> {
    const firstLoad = !this.backupOverviewLoaded
    this.backupOverviewLoaded = true
    if (reuseBackupOverviewOnce && backupOverviewCache) {
      reuseBackupOverviewOnce = false
      return Promise.resolve(backupOverviewCache)
    }
    if (firstLoad && backupOverviewCache) return Promise.resolve(backupOverviewCache)
    if (backupOverviewInFlight) return backupOverviewInFlight
    reuseBackupOverviewOnce = false
    backupOverviewInFlight = requestJson<BackupOverviewResponseDto>('/api/v1/backups').then(
      result => {
        backupOverviewCache = result
        backupOverviewInFlight = null
        return result
      },
      error => {
        backupOverviewInFlight = null
        throw error
      },
    )
    return backupOverviewInFlight
  }

  async refreshBackupOverview(): Promise<BackupOverviewResponseDto> {
    this.backupOverviewLoaded = true
    reuseBackupOverviewOnce = false
    const result = await requestJson<BackupOverviewResponseDto>('/api/v1/backups/refresh', { method: 'POST' })
    backupOverviewCache = result
    return result
  }

  backupSnapshot(id: string): Promise<BackupSnapshotResponseDto> {
    return requestJson(`/api/v1/backups/${encodeURIComponent(id)}`)
  }

  async createBackup(input: BackupCreateRequestDto): Promise<BackupSnapshotResponseDto> {
    const result = await requestJson<BackupSnapshotResponseDto>('/api/v1/backups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    rememberBackupSnapshot(result)
    return result
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

  async importBackup(file: Blob): Promise<BackupSnapshotResponseDto> {
    const result = await requestJson<BackupSnapshotResponseDto>('/api/v1/backups/import', {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.agentlens.backup' },
      body: file,
    })
    rememberBackupSnapshot(result)
    return result
  }

  subscribe(
    onEvent: (event: LiveUpdateEventDto) => void,
    onConnection: (connected: boolean) => void,
    onReconnect?: () => void,
  ): () => void {
    const source = new EventSource('/api/v1/events')
    let opened = false
    let disconnectedAfterOpen = false
    let disposed = false

    source.onopen = () => {
      if (disposed) return
      const reconnecting = opened && disconnectedAfterOpen
      opened = true
      disconnectedAfterOpen = false
      onConnection(true)
      if (reconnecting) {
        onReconnect?.()
        window.dispatchEvent(new Event(LIVE_RECONNECTED_EVENT))
      }
    }
    source.onerror = () => {
      if (disposed) return
      if (opened) disconnectedAfterOpen = true
      onConnection(false)
    }
    source.addEventListener('observation', raw => {
      if (disposed || !(raw instanceof MessageEvent) || typeof raw.data !== 'string') return
      try { onEvent(parseLiveUpdateEvent(JSON.parse(raw.data))) } catch { /* ignore malformed frame */ }
    })
    return () => {
      disposed = true
      source.close()
      onConnection(false)
    }
  }
}
