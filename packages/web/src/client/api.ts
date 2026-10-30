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
  type HostFilePreviewResponseDto,
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
  type NativeBodySearchResponseDto,
  type NativeMetricOverviewResponseDto,
  type NativeMetricStatusDto,
  type NativeSessionCatalogResponseDto,
  type NativeSessionSummaryDto,
  type NativeReviewWindowResponseDto,
  type NativeReviewTurnIndexResponseDto,
  type ReviewDetailDirection,
  type ReviewDetailFilter,
  type ReviewInteractionDto,
  type ReviewMessageAttachmentDto,
  type ReviewMessageAttachmentsResponseDto,
  type ReviewProcessMode,
  type ReviewResponseDto,
  type ReviewSessionDetailDto,
  type ReviewSessionSummaryDto,
  type SessionRelationshipResponseDto,
  type TaskFileChangesResponseDto,
  type TaskFileDiffResponseDto,
  type SourceRecordResponseDto,
  type SourceRecordsResponseDto,
  type ToolAssetUsageResponseDto,
} from '@agent-lens/protocol'
import { translateProduct } from '../i18n/runtime'
import { BACKGROUND_ACTIVITY_CHANGED_EVENT } from './background-activity'
import { shareAbortableInFlight, shareInFlight, type AbortableInFlightEntry } from './single-flight'

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
const abortableAggregateReadInFlight = new Map<string, AbortableInFlightEntry>()

export function rangeStart(range: QueryFilters['range']): string | undefined {
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
    if (error instanceof DOMException && error.name === 'AbortError') throw error
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
  updateIntegration(integrationId: string): Promise<IntegrationPackageOperationResponseDto> {
    return requestJson(`/api/v1/integrations/${encodeURIComponent(integrationId)}/update`, {
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

  /** Session metadata from original agents, never from duplicated SQLite events. */
  nativeSessions(options: {
    sourceId?: string
    installationId?: string
    projectId?: string
    search?: string
    limit?: number
    cursor?: string
    signal?: AbortSignal
  } = {}): Promise<NativeSessionCatalogResponseDto> {
    const params = new URLSearchParams()
    if (options.sourceId) params.set('sourceId', options.sourceId)
    if (options.installationId) params.set('installationId', options.installationId)
    if (options.projectId) params.set('projectId', options.projectId)
    if (options.search?.trim()) params.set('search', options.search.trim().slice(0,256))
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.limit !== undefined) {
      params.set('limit', String(Math.max(1, Math.min(options.limit, 100))))
    }
    return requestJson<NativeSessionCatalogResponseDto>(
      `/api/v1/native-sessions${params.size ? `?${params}` : ''}`,
      options.signal ? { signal: options.signal } : {},
    )
  }

  /** Bounded Source-owned body text search, complementary to SQL legacy Review.
   * Every result is one catalog session / one native page. Keep paging through
   * empty pages until hasMore=false; no content is saved in a local SQL index.
   */
  nativeBodySearch(query: string, options: {
    sourceId?: string
    cursor?: string
    signal?: AbortSignal
  } = {}): Promise<NativeBodySearchResponseDto> {
    const params=new URLSearchParams({q:query.trim()})
    if(options.sourceId)params.set('sourceId',options.sourceId)
    if(options.cursor)params.set('cursor',options.cursor)
    return requestJson<NativeBodySearchResponseDto>(
      `/api/v1/native-sessions/search?${params}`,
      options.signal ? {signal:options.signal} : {},
    )
  }

  /** Read global source-owned numerical totals, without scanning native files.
   * A partial coverage response is NOT a complete global usage count.
   */
  nativeMetricsOverview(options:{
    sourceId?:string;from?:string;to?:string;signal?:AbortSignal
  }={}):Promise<NativeMetricOverviewResponseDto>{
    const params=new URLSearchParams()
    if(options.sourceId)params.set('sourceId',options.sourceId)
    if(options.from)params.set('from',options.from)
    if(options.to)params.set('to',options.to)
    return requestJson<NativeMetricOverviewResponseDto>(
      `/api/v1/native-sessions/metrics/overview${params.size?`?${params}`:''}`,
      options.signal?{signal:options.signal}:{},
    )
  }

  /** Reload a native Session after a page refresh without a full Catalog scan. */
  nativeSession(id: string, signal?: AbortSignal): Promise<NativeSessionSummaryDto | null> {
    return requestJson<NativeSessionSummaryDto>(
      `/api/v1/native-sessions/${encodeURIComponent(id)}`,
      signal ? { signal } : {},
    ).catch(error => error instanceof AgentLensRequestError && error.status === 404
      ? null : Promise.reject(error))
  }

  /** Read only the disposable numerical projection state; never the native body. */
  nativeMetricStatus(id: string, signal?: AbortSignal): Promise<NativeMetricStatusDto> {
    return requestJson<NativeMetricStatusDto>(
      `/api/v1/native-sessions/${encodeURIComponent(id)}/metrics`,
      signal ? { signal } : {},
    )
  }

  /** Explicit, bounded materialization for an opened Native-only session. */
  rebuildNativeMetric(id: string, signal?: AbortSignal): Promise<NativeMetricStatusDto> {
    return requestJson<NativeMetricStatusDto>(
      `/api/v1/native-sessions/${encodeURIComponent(id)}/metrics/rebuild`,
      { method: 'POST', ...(signal ? { signal } : {}) },
    )
  }

  /** Read one bounded native Review window through the existing Task DTO.
   * This does not silently fall back to SQL rows or claim incomplete turns are complete.
   */
  nativeReviewWindow(identity: {
    sourceId: string
    installationId: string
    nativeSessionId: string
  }, options: {
    cursor?: string
    format?: 'review' | 'review-turns'
    limit?: number
    /** Batch complete turns, not native source records; maximum four per request. */
    turnLimit?: number
    signal?: AbortSignal
  } = {}): Promise<NativeReviewWindowResponseDto> {
    const params = new URLSearchParams({
      sourceId: identity.sourceId,
      installationId: identity.installationId,
      nativeSessionId: identity.nativeSessionId,
      format: options.format ?? 'review-turns',
    })
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.limit !== undefined) {
      params.set('limit', String(Math.max(1, Math.min(options.limit, 16))))
    }
    if (options.turnLimit !== undefined) {
      params.set('turnLimit', String(Math.max(1, Math.min(options.turnLimit, 4))))
    }
    return requestJson<NativeReviewWindowResponseDto>(
      `/api/v1/native-sessions/window?${params}`,
      options.signal ? { signal: options.signal } : {},
    )
  }

  /** Stable-ID native Review deep link. Source identity remains resolved on the daemon. */
  nativeReviewById(id: string, options: {
    cursor?: string
    turnLimit?: number
    limit?: number
    signal?: AbortSignal
  } = {}): Promise<NativeReviewWindowResponseDto> {
    const params = new URLSearchParams()
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.turnLimit !== undefined) params.set('turnLimit',
      String(Math.max(1, Math.min(options.turnLimit, 4))))
    if (options.limit !== undefined) params.set('limit',
      String(Math.max(1, Math.min(options.limit, 16))))
    return requestJson<NativeReviewWindowResponseDto>(
      `/api/v1/native-sessions/${encodeURIComponent(id)}/review${params.size ? `?${params}` : ''}`,
      options.signal ? { signal: options.signal } : {},
    )
  }

  /** Read sparse native turn locators. Scan stays bounded and does not hydrate Review text. */
  nativeReviewTurnIndex(id: string, options: {
    ordinal?: number
    tail?: number
    from?: number
    around?: number
    limit?: number
    scan?: boolean
    signal?: AbortSignal
  } = {}): Promise<NativeReviewTurnIndexResponseDto> {
    const params = new URLSearchParams()
    if (options.ordinal !== undefined) params.set('ordinal', String(options.ordinal))
    if (options.tail !== undefined) params.set('tail', String(options.tail))
    if (options.from !== undefined) params.set('from', String(options.from))
    if (options.around !== undefined) params.set('around', String(options.around))
    if (options.limit !== undefined) params.set('limit', String(options.limit))
    if (options.scan) params.set('scan', '1')
    return requestJson<NativeReviewTurnIndexResponseDto>(
      `/api/v1/native-sessions/${encodeURIComponent(id)}/turn-index${params.size ? `?${params}` : ''}`,
      options.signal ? {signal:options.signal} : {},
    )
  }

  /** Source-owned Hook evidence is deliberately independent of user-turn pagination.
   * Its partial boundary MUST NOT be used as a complete native Review page.
   */
  nativeReviewHooksById(id: string, options: { cursor?: string; signal?: AbortSignal } = {}): Promise<NativeReviewWindowResponseDto> {
    const params = new URLSearchParams()
    if (options.cursor) params.set('cursor', options.cursor)
    return requestJson<NativeReviewWindowResponseDto>(
      `/api/v1/native-sessions/${encodeURIComponent(id)}/hooks${params.size ? `?${params}` : ''}`,
      options.signal ? {signal:options.signal} : {},
    )
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

  nativeReviewAttachments(
    sessionId: string, observationId: string, cursor: string,
  ): Promise<ReviewMessageAttachmentDto[]> {
    const params=new URLSearchParams({cursor})
    return requestJson<ReviewMessageAttachmentsResponseDto>(
      `/api/v1/native-sessions/${encodeURIComponent(sessionId)}/observations/${encodeURIComponent(observationId)}/attachments?${params}`,
    ).then(result=>result.items)
  }

  reviewAttachments(observationId: string): Promise<ReviewMessageAttachmentDto[]> {
    const requestPath = `/api/v1/review/observations/${encodeURIComponent(observationId)}/attachments`
    return shareInFlight(
      aggregateReadInFlight,
      `review-attachments:${observationId}`,
      () => requestJson<ReviewMessageAttachmentsResponseDto>(requestPath).then(result => result.items),
    )
  }

  reviewFileChanges(id: string, signal?: AbortSignal): Promise<TaskFileChangesResponseDto> {
    const requestPath = `/api/v1/review/${encodeURIComponent(id)}/file-changes`
    // A session-switch request must be cancellable without aborting the shared
    // background/SSE aggregate read used by other consumers.
    if (signal) return requestJson<TaskFileChangesResponseDto>(requestPath, { signal })
    return shareInFlight(
      aggregateReadInFlight,
      `review-file-changes:${id}`,
      () => requestJson<TaskFileChangesResponseDto>(requestPath),
    )
  }

  reviewInteractionFileChanges(
    id: string,
    interaction: { id: string; startedAt: string; endedAt: string; observationIds?: readonly string[]; observationRange?: { firstId: string; lastId: string } },
    signal?: AbortSignal,
  ): Promise<TaskFileChangesResponseDto> {
    const params = new URLSearchParams({
      interactionId: interaction.id,
      from: interaction.startedAt,
      to: interaction.endedAt,
    })
    if (interaction.observationRange) {
      params.set('firstObservationId', interaction.observationRange.firstId)
      params.set('lastObservationId', interaction.observationRange.lastId)
    }
      for (const observationId of interaction.observationIds ?? []) params.append('observationId', observationId)
    return requestJson<TaskFileChangesResponseDto>(
      `/api/v1/review/${encodeURIComponent(id)}/file-changes?${params}`,
      signal ? { signal } : {},
    )
  }

  runtimeFileChanges(runtimeSessionId: string, signal?: AbortSignal): Promise<TaskFileChangesResponseDto | null> {
    return requestJson<TaskFileChangesResponseDto | null>(
      `/api/v1/task-file-changes/runtime/${encodeURIComponent(runtimeSessionId)}`,
      signal ? { signal } : {},
    )
  }

  reviewFileDiff(id: string, path: string, signal?: AbortSignal): Promise<TaskFileDiffResponseDto> {
    const query = new URLSearchParams({ path })
    return requestJson<TaskFileDiffResponseDto>(
      `/api/v1/review/${encodeURIComponent(id)}/file-diff?${query}`,
      signal ? { signal } : {},
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
      process?: ReviewProcessMode
      signal?: AbortSignal
    } = {},
  ): Promise<ReviewSessionDetailDto> {
    const params = new URLSearchParams()
    if (options.cursor) params.set('cursor', options.cursor)
    if (options.ordinal !== undefined) params.set('ordinal', String(options.ordinal))
    if (options.afterOrdinal !== undefined) params.set('afterOrdinal', String(options.afterOrdinal))
    if (options.direction) params.set('direction', options.direction)
    if (options.filter && options.filter !== 'all') params.set('filter', options.filter)
    if (options.process) params.set('process', options.process)
    if (options.limit !== undefined) params.set('limit', String(Math.max(1, Math.min(options.limit, 100))))
    const query = params.toString()
    return requestJson<ReviewSessionDetailDto>(`/api/v1/review/${encodeURIComponent(id)}${query ? `?${query}` : ''}`, options.signal ? { signal: options.signal } : {})
  }

  reviewProcessDetail(
    id: string,
    ordinal: number,
    revision: string,
    signal?: AbortSignal,
  ): Promise<ReviewInteractionDto | null> {
    const requestPath = `/api/v1/review/${encodeURIComponent(id)}?ordinal=${ordinal}&process=full`
    return shareAbortableInFlight(
      abortableAggregateReadInFlight,
      `review-process:${id}:${ordinal}:${revision}`,
      sharedSignal => requestJson<ReviewSessionDetailDto>(requestPath, { signal: sharedSignal }),
      signal,
    ).then(detail => detail.interactions.find(interaction => interaction.ordinal === ordinal) ?? null)
  }

  relationships(id: string, signal?: AbortSignal): Promise<SessionRelationshipResponseDto> {
    return requestJson(`/api/v1/relationships?logicalSessionId=${encodeURIComponent(id)}`, signal ? { signal } : {})
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

  previewHostFile(path: string): Promise<HostFilePreviewResponseDto> {
    return requestJson('/api/v1/host/file-preview', {
      method: 'POST',
      headers: { 'X-AgentLens-Host-File-Preview-Path': encodeURIComponent(path) },
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
    source.addEventListener('background-activity', () => {
      if (!disposed) window.dispatchEvent(new Event(BACKGROUND_ACTIVITY_CHANGED_EVENT))
    })
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
