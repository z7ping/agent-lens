import {
  parseLiveUpdateEvent,
  type AgentCoverageResponseDto,
  type AgentDetailResponseDto,
  type AgentEnrichmentResponseDto,
  type AgentOverviewResponseDto,
  type AgentRescanResponseDto,
  type AgentSummaryResponseDto,
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
  type IntegrationAuthorizationCapabilityDto,
  type IntegrationAuthorizationResponseDto,
  type IntegrationEnabledUpdateResponseDto,
  type IntegrationManagementResponseDto,
  type IntegrationPackageOperationResponseDto,
  type IntegrationPreferenceUpdateRequestDto,
  type IntegrationPreferencesResponseDto,
  type IntegrationToolDiscoveryResponseDto,
  type LiveUpdateEventDto,
  type ManagedAssetDirectoryResponseDto,
  type ManagedAssetFilePreviewResponseDto,
  type ManagedAssetRoot,
  type ReviewDetailDirection,
  type ReviewDetailFilter,
  type ReviewMessageAttachmentDto,
  type ReviewMessageAttachmentsResponseDto,
  type ReviewResponseDto,
  type ReviewSessionDetailDto,
  type ReviewSessionSummaryDto,
  type SessionRelationshipResponseDto,
  type SourceRecordResponseDto,
  type SourceRecordsResponseDto,
  type ToolAssetUsageResponseDto,
} from '@agent-lens/protocol'
import { translateProduct } from '../i18n/runtime'
import { shareInFlight } from './single-flight'

export const LIVE_RECONNECTED_EVENT = 'agent-lens:live-reconnected'

export interface QueryFilters {
  /** null 表示全部来源；空数组表示明确不选择任何来源。 */
  sourceIds: string[] | null
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
const managedAssetReadInFlight = new Map<string, Promise<unknown>>()
const aggregateReadInFlight = new Map<string, Promise<unknown>>()

function rangeStart(range: QueryFilters['range']): string | undefined {
  if (range === 'all') return undefined
  const date = new Date()
  if (range === 'today') date.setHours(0, 0, 0, 0)
  else date.setDate(date.getDate() - (range === '7d' ? 7 : 30))
  return date.toISOString()
}

function appendFilters(params: URLSearchParams, filters: QueryFilters): void {
  if (filters.sourceIds !== null) {
    if (!filters.sourceIds.length) params.append('sourceId', '')
    else for (const sourceId of filters.sourceIds) params.append('sourceId', sourceId)
  }
  if (filters.projectId) params.set('projectId', filters.projectId)
  const from = rangeStart(filters.range)
  if (from) params.set('from', from)
}

function queryFilterKey(filters: QueryFilters): string {
  return JSON.stringify({
    sourceIds: filters.sourceIds === null ? null : [...filters.sourceIds].sort(),
    projectId: filters.projectId,
    range: filters.range,
  })
}

function responseErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const message = Reflect.get(value, 'message')
  return typeof message === 'string' && message ? message : undefined
}

export class AgentLensRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'AgentLensRequestError'
  }
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
      throw new AgentLensRequestError(translateProduct('errors:apiRequestFailedStatus', { status: response.status, detail, path }), response.status)
    }
    return response.json() as Promise<T>
  } catch (error) {
    if (error instanceof AgentLensRequestError) throw error
    throw new AgentLensRequestError(translateProduct('errors:apiRequestFailed'))
  }
}

async function requestBlob(path: string): Promise<Blob> {
  try {
    const response = await fetch(path, { headers: { accept: 'application/vnd.agentlens.backup' } })
    if (!response.ok) throw new AgentLensRequestError(translateProduct('errors:apiRequestFailedStatus', { status: response.status, detail: '', path }), response.status)
    return response.blob()
  } catch (error) {
    if (error instanceof AgentLensRequestError) throw error
    throw new AgentLensRequestError(translateProduct('errors:backupExportFailed'))
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
  agentSummaries(): Promise<AgentSummaryResponseDto> {
    return shareInFlight(
      aggregateReadInFlight,
      'agent-summaries',
      () => requestJson('/api/v1/agents/summary'),
    )
  }

  agentCoverage(): Promise<AgentCoverageResponseDto> {
    return shareInFlight(
      aggregateReadInFlight,
      'agent-coverage',
      () => requestJson('/api/v1/agents/coverage'),
    )
  }
  agentDetail(sourceId: string): Promise<AgentDetailResponseDto | null> {
    const requestPath = `/api/v1/agents/${encodeURIComponent(sourceId)}`
    return shareInFlight(
      aggregateReadInFlight,
      `agent-detail:${sourceId}`,
      () => requestJson<AgentDetailResponseDto>(requestPath)
        .catch(error => error instanceof AgentLensRequestError && error.status === 404 ? null : Promise.reject(error)),
    )
  }

  agentEnrichment(sourceId: string): Promise<AgentEnrichmentResponseDto | null> {
    const requestPath = `/api/v1/agents/${encodeURIComponent(sourceId)}/enrichment`
    return shareInFlight(
      aggregateReadInFlight,
      `agent-enrichment:${sourceId}`,
      () => requestJson<AgentEnrichmentResponseDto>(requestPath)
        .catch(error => error instanceof AgentLensRequestError && error.status === 404 ? null : Promise.reject(error)),
    )
  }

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
  rescanAgents(sourceId?: string): Promise<AgentRescanResponseDto> {
    const query = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : ''
    return requestJson(`/api/v1/agents/rescan${query}`, { method: 'POST' })
  }
  managedAssetDirectory(
    productId: string,
    installationId: string,
    root: ManagedAssetRoot,
    path = '',
    bindingId?: string,
  ): Promise<ManagedAssetDirectoryResponseDto> {
    const params = new URLSearchParams({ installationId, root })
    if (path) params.set('path', path)
    if (bindingId) params.set('bindingId', bindingId)
    const requestPath = `/api/v1/integrations/${encodeURIComponent(productId)}/assets/files?${params}`
    return shareInFlight(
      managedAssetReadInFlight,
      requestPath,
      () => requestJson<ManagedAssetDirectoryResponseDto>(requestPath),
    )
  }
  managedAssetFile(
    productId: string,
    installationId: string,
    root: ManagedAssetRoot,
    path: string,
    bindingId?: string,
  ): Promise<ManagedAssetFilePreviewResponseDto> {
    const params = new URLSearchParams({ installationId, root, path })
    if (bindingId) params.set('bindingId', bindingId)
    const requestPath = `/api/v1/integrations/${encodeURIComponent(productId)}/assets/file?${params}`
    return shareInFlight(
      managedAssetReadInFlight,
      requestPath,
      () => requestJson<ManagedAssetFilePreviewResponseDto>(requestPath),
    )
  }
  integrationDiscovery(): Promise<IntegrationToolDiscoveryResponseDto> {
    return requestJson('/api/v1/integrations/discovery')
  }
  rescanIntegrationDiscovery(integrationId?: string): Promise<IntegrationToolDiscoveryResponseDto> {
    const query = integrationId ? `?integrationId=${encodeURIComponent(integrationId)}` : ''
    return requestJson(`/api/v1/integrations/discovery/rescan${query}`, { method: 'POST' })
  }
  integrations(): Promise<IntegrationManagementResponseDto> {
    return requestJson('/api/v1/integrations')
  }
  integrationPreferences(): Promise<IntegrationPreferencesResponseDto> {
    return requestJson('/api/v1/integrations/preferences')
  }
  updateIntegrationPreferences(
    input: IntegrationPreferenceUpdateRequestDto,
  ): Promise<IntegrationPreferencesResponseDto> {
    return requestJson('/api/v1/integrations/preferences', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  }
  installIntegration(integrationId: string): Promise<IntegrationPackageOperationResponseDto> {
    return requestJson(`/api/v1/integrations/${encodeURIComponent(integrationId)}/install`, {
      method: 'POST',
    })
  }
  removeIntegration(integrationId: string): Promise<IntegrationPackageOperationResponseDto> {
    return requestJson(`/api/v1/integrations/${encodeURIComponent(integrationId)}`, {
      method: 'DELETE',
    })
  }
  setIntegrationEnabled(
    integrationId: string,
    enabled: boolean,
  ): Promise<IntegrationEnabledUpdateResponseDto> {
    return requestJson(`/api/v1/integrations/${encodeURIComponent(integrationId)}/enabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
  }
  capturePolicy(): Promise<CapturePolicyResponseDto> { return requestJson('/api/v1/capture-policy/sources') }

  updateCaptureSources(enabledSources: readonly string[]): Promise<CapturePolicyResponseDto> {
    return requestJson('/api/v1/capture-policy/sources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabledSources }),
    })
  }

  authorizeIntegration(
    productId: string,
    capabilities: readonly IntegrationAuthorizationCapabilityDto[],
  ): Promise<IntegrationAuthorizationResponseDto> {
    return requestJson(`/api/v1/integrations/${encodeURIComponent(productId)}/authorization`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capabilities }),
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

  reviewAttachments(observationId: string): Promise<ReviewMessageAttachmentDto[]> {
    const requestPath = `/api/v1/review/observations/${encodeURIComponent(observationId)}/attachments`
    return shareInFlight(
      aggregateReadInFlight,
      `review-attachments:${observationId}`,
      () => requestJson<ReviewMessageAttachmentsResponseDto>(requestPath).then(result => result.items),
    )
  }

  reviewSummary(id: string): Promise<ReviewSessionSummaryDto | null> {
    return requestJson<ReviewSessionSummaryDto>(`/api/v1/review/${encodeURIComponent(id)}/summary`)
      .catch(error => error instanceof AgentLensRequestError && error.status === 404 ? null : Promise.reject(error))
  }

  reviewDetail(
    id: string,
    options: {
      cursor?: string
      ordinal?: number
      afterOrdinal?: number
      limit?: number
      direction?: ReviewDetailDirection
      filter?: ReviewDetailFilter
    } = {},
  ): Promise<ReviewSessionDetailDto> {
    const params = new URLSearchParams()
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.ordinal !== undefined) params.set('ordinal', String(options.ordinal))
    if (options.afterOrdinal !== undefined) params.set('afterOrdinal', String(options.afterOrdinal))
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

  sourceRecords(ids: readonly string[]): Promise<SourceRecordResponseDto[]> {
    const unique = [...new Set(ids.map(id => id.trim()).filter(Boolean))].slice(0, 50)
    if (!unique.length) return Promise.resolve([])
    const params = new URLSearchParams()
    for (const id of unique) params.append('id', id)
    const requestPath = `/api/v1/source-records?${params}`
    return shareInFlight(
      aggregateReadInFlight,
      `source-records:${unique.join('\u0000')}`,
      () => requestJson<SourceRecordsResponseDto>(requestPath).then(result => result.items),
    )
  }

  usage(filters: QueryFilters): Promise<ToolAssetUsageResponseDto> {
    const params = new URLSearchParams()
    appendFilters(params, filters)
    params.set('limit', '500')
    const requestPath = `/api/v1/usage?${params}`
    return shareInFlight(
      aggregateReadInFlight,
      `usage:${queryFilterKey(filters)}`,
      () => requestJson<ToolAssetUsageResponseDto>(requestPath),
    )
  }

  usageDetail(filters: QueryFilters, toolName: string): Promise<ToolAssetUsageResponseDto> {
    const params = new URLSearchParams()
    appendFilters(params, filters)
    params.set('toolName', toolName)
    params.set('limit', '1')
    const requestPath = `/api/v1/usage/detail?${params}`
    return shareInFlight(
      aggregateReadInFlight,
      `usage-detail:${queryFilterKey(filters)}:${toolName}`,
      () => requestJson<ToolAssetUsageResponseDto>(requestPath),
    )
  }

  insights(filters: QueryFilters): Promise<InsightsResponseDto> {
    const params = new URLSearchParams()
    appendFilters(params, filters)
    const requestPath = `/api/v1/insights?${params}`
    return shareInFlight(
      aggregateReadInFlight,
      `insights:${queryFilterKey(filters)}`,
      () => requestJson<InsightsResponseDto>(requestPath),
    )
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

  async pollBackupOverview(): Promise<BackupOverviewResponseDto> {
    this.backupOverviewLoaded = true
    const result = await shareInFlight(
      aggregateReadInFlight,
      'backup-overview:background',
      () => requestJson<BackupOverviewResponseDto>('/api/v1/backups?background=1'),
    )
    backupOverviewCache = result
    reuseBackupOverviewOnce = false
    return result
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

  openHostPath(path: string): Promise<{ opened: boolean; action?: 'opened' | 'revealed' }> {
    return requestJson('/api/v1/host/open-path', {
      method: 'POST',
      headers: { 'X-AgentLens-Host-Open-Path-Path': encodeURIComponent(path) },
    })
  }

  openHostDirectory(path: string): Promise<{ opened: boolean; action?: 'opened' | 'revealed' }> {
    return this.openHostPath(path)
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
