import { AGENT_LENS_PROTOCOL_VERSION, type JsonValue, type TimelineEvidenceDto, type TimelineObservationKind } from './timeline'

export type ReviewStatusFilter = 'all' | 'with-errors' | 'clean'
export type ReviewMessageRole = 'user' | 'assistant' | 'commentary' | 'reasoning'
export type ReviewEventCategory = 'permission' | 'subagent' | 'context' | 'model' | 'lifecycle' | 'artifact' | 'usage' | 'unknown'
export type ReviewDetailFilter = 'all' | 'errors' | 'latency' | 'latest'
export type ReviewDetailDirection = 'forward' | 'backward'
export type ReviewSessionActivity = 'user-task' | 'branch-task' | 'subagent' | 'internal-review' | 'system-activity'

export type ReviewMessageAttachmentType = 'image' | 'file'

export interface ReviewMessageAttachmentDto {
  type: ReviewMessageAttachmentType
  name?: string
  mimeType?: string
  sizeBytes?: number
  /**
   * Only inline image data is exposed to Web. Native file paths / arbitrary
   * external URLs are intentionally not promoted into the public Review contract.
   */
  dataUrl?: string
}

function attachmentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function attachmentString(record: Readonly<Record<string, unknown>>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function attachmentSize(record: Readonly<Record<string, unknown>>): number | undefined {
  for (const key of ['sizeBytes', 'size_bytes', 'size']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  }
  return undefined
}

function safeAttachmentName(value: string | undefined): string | undefined {
  if (!value) return undefined
  const name = value.split(/[\\/]/).filter(Boolean).at(-1)?.trim()
  return name || undefined
}

function inlineImageDataUrl(record: Readonly<Record<string, unknown>>, mimeType?: string): string | undefined {
  const dataUrl = attachmentString(record, 'dataUrl', 'data_url')
  if (dataUrl && /^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) return dataUrl

  const data = attachmentString(record, 'data', 'base64')
  if (!data) return undefined
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(data)) return data
  if (!mimeType?.toLowerCase().startsWith('image/')) return undefined

  const normalized = data.replace(/\s+/g, '')
  if (!normalized || !/^[A-Za-z0-9+/=_-]+$/.test(normalized)) return undefined
  return `data:${mimeType};base64,${normalized}`
}

function attachmentFromValue(value: unknown, wrapperKind?: string): ReviewMessageAttachmentDto | null {
  if (typeof value === 'string') {
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) {
      const mimeType = value.slice(5, value.indexOf(';')).toLowerCase()
      return { type: 'image', mimeType, dataUrl: value }
    }
    return wrapperKind === 'images' || wrapperKind === 'local_images'
      ? { type: 'image' }
      : null
  }

  const record = attachmentRecord(value)
  if (!Object.keys(record).length) return null
  const explicitType = attachmentString(record, 'type', 'kind')
  const mimeType = attachmentString(record, 'mimeType', 'mime_type', 'mediaType', 'media_type')?.toLowerCase()
  const image = explicitType === 'image'
    || Boolean(mimeType?.startsWith('image/'))
    || wrapperKind === 'images'
    || wrapperKind === 'local_images'
  const file = explicitType === 'file' || wrapperKind === 'attachments'
  if (!image && !file) return null

  const name = safeAttachmentName(attachmentString(record, 'name', 'fileName', 'file_name', 'filename', 'path'))
  const sizeBytes = attachmentSize(record)
  const dataUrl = image ? inlineImageDataUrl(record, mimeType) : undefined
  return {
    type: image ? 'image' : 'file',
    ...(name ? { name } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(dataUrl ? { dataUrl } : {}),
  }
}

/**
 * Projects source-normalized historical message payloads into the public Review
 * attachment contract. The helper understands the canonical `attachments`
 * field plus the legacy Pi `nonTextContent` field so existing databases do
 * not require a destructive replay just to render previously sent images.
 */
export function reviewMessageAttachmentsFromPayload(value: JsonValue | unknown): ReviewMessageAttachmentDto[] {
  const payload = attachmentRecord(value)
  const candidates: Array<{ value: unknown; wrapperKind?: string }> = []

  const attachments = payload.attachments
  if (Array.isArray(attachments)) {
    for (const raw of attachments) {
      const wrapper = attachmentRecord(raw)
      const wrapperKind = attachmentString(wrapper, 'kind')
      if (wrapperKind && Object.prototype.hasOwnProperty.call(wrapper, 'value')) {
        candidates.push({ value: wrapper.value, wrapperKind })
      } else {
        candidates.push({ value: raw })
      }
    }
  }

  const legacy = payload.nonTextContent
  if (Array.isArray(legacy)) {
    for (const raw of legacy) candidates.push({ value: raw })
  }

  return candidates
    .map(candidate => attachmentFromValue(candidate.value, candidate.wrapperKind))
    .filter((attachment): attachment is ReviewMessageAttachmentDto => attachment !== null)
}

export interface ReviewNodeSourceDto {
  nativeEventId?: string
  nativeParentEventId?: string
  parentObservationId?: string
  occurredAt?: string
  capturedAt: string
}

export interface ReviewSessionSummaryDto {
  id: string
  installationId: string
  productId: string
  sourceIds: string[]
  projectId?: string
  projectName?: string
  workspaceId?: string
  workspacePath?: string
  title?: string
  preview?: string
  startedAt: string
  endedAt: string
  durationMs: number
  observationCount: number
  /** 兼容字段：严格等于真实用户轮次。 */
  interactionCount: number
  userTurnCount?: number
  systemContextCount?: number
  internalReviewCount?: number
  otherEventCount?: number
  toolCount: number
  errorCount: number
  hasErrors: boolean
  sessionActivity?: ReviewSessionActivity
  activitySourceLabel?: string
  parentSessionId?: string
  /** 搜索命中系统/工具/审查内容时由服务端返回来源。 */
  searchMatchSources?: Array<'title' | 'user' | 'system' | 'review' | 'tool' | 'other'>
}

export interface ReviewMessageNodeDto extends ReviewNodeSourceDto {
  type: 'message'
  id: string
  role: ReviewMessageRole
  at: string
  sourceId: string
  text: string
  attachments?: ReviewMessageAttachmentDto[]
  payload: JsonValue
  evidence: TimelineEvidenceDto[]
  observationIds: string[]
}

export interface ReviewToolNodeDto extends ReviewNodeSourceDto {
  type: 'tool'
  id: string
  at: string
  sourceId: string
  name: string
  callId?: string
  status: 'running' | 'success' | 'error' | 'unknown'
  startedAt: string
  endedAt?: string
  durationMs?: number
  input?: JsonValue
  output?: JsonValue
  payload: JsonValue
  evidence: TimelineEvidenceDto[]
  observationIds: string[]
}

export interface ReviewEventNodeDto extends ReviewNodeSourceDto {
  type: 'event'
  id: string
  at: string
  sourceId: string
  kind: TimelineObservationKind
  category: ReviewEventCategory
  label: string
  payload: JsonValue
  evidence: TimelineEvidenceDto[]
  observationIds: string[]
}

export type ReviewNodeDto = ReviewMessageNodeDto | ReviewToolNodeDto | ReviewEventNodeDto

export interface ReviewInteractionDto {
  id: string
  ordinal: number
  trigger: 'user' | 'background'
  startedAt: string
  endedAt: string
  nodes: ReviewNodeDto[]
  /** 单轮节点超过服务端稳定性边界时，仅返回有界的首尾窗口。 */
  nodesTruncated?: boolean
  /** 截断前该轮的完整 Review 节点数。 */
  totalNodeCount?: number
  /** 本次响应中未返回的中间节点数。 */
  omittedNodeCount?: number
}

export interface ReviewInteractionIndexDto {
  id: string
  ordinal: number
  trigger: 'user' | 'background'
  startedAt: string
  endedAt: string
  hasError: boolean
  preview?: string
}

export interface ReviewDetailPageDto {
  count: number
  hasMore: boolean
  nextCursor?: string
  direction: ReviewDetailDirection
  filter: ReviewDetailFilter
  latencyThresholdMs?: number
}

export interface ReviewSessionDetailDto extends ReviewSessionSummaryDto {
  interactions: ReviewInteractionDto[]
  interactionIndex?: ReviewInteractionIndexDto[]
  page: ReviewDetailPageDto
}

export interface ReviewDetailQueryDto {
  cursor?: string
  ordinal?: number
  limit?: number
  direction?: ReviewDetailDirection
  filter?: ReviewDetailFilter
}

export interface ReviewQueryDto {
  cursor?: string
  sourceIds?: string[]
  /** @deprecated 单来源兼容参数；新调用方使用 sourceIds。 */
  sourceId?: string
  projectId?: string
  from?: string
  to?: string
  status?: ReviewStatusFilter
  search?: string
  limit?: number
}

export interface ReviewResponseDto {
  items: ReviewSessionSummaryDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    count: number
    hasMore: boolean
    nextCursor?: string
    generatedAt: string
  }
}
