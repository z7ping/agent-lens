import type {
  HealthResponseDto,
  SessionQueryDto,
  SessionResponseDto,
  TimelineQueryDto,
  TimelineResponseDto,
  ToolAssetUsageQueryDto,
  ToolAssetUsageResponseDto,
} from '@agent-lens/protocol'

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = await response.json() as { message?: string; error?: string }
      message = body.message ?? body.error ?? message
    } catch {}
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

function scopedParams(query: { installationId?: string; logicalSessionId?: string; limit?: number }): URLSearchParams {
  const params = new URLSearchParams()
  if (query.installationId) params.set('installationId', query.installationId)
  if (query.logicalSessionId) params.set('logicalSessionId', query.logicalSessionId)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  return params
}

function withParams(path: string, params: URLSearchParams): string {
  return params.size ? `${path}?${params.toString()}` : path
}

export function getHealth(): Promise<HealthResponseDto> {
  return requestJson('/api/v1/health')
}

export function getTimeline(query: TimelineQueryDto = {}): Promise<TimelineResponseDto> {
  const params = scopedParams(query)
  if (query.kind) params.set('kind', query.kind)
  if (query.from) params.set('from', query.from)
  if (query.to) params.set('to', query.to)
  return requestJson(withParams('/api/v1/timeline', params))
}

export function getSessions(query: SessionQueryDto = {}): Promise<SessionResponseDto> {
  return requestJson(withParams('/api/v1/sessions', scopedParams(query)))
}

export function getUsage(query: ToolAssetUsageQueryDto = {}): Promise<ToolAssetUsageResponseDto> {
  return requestJson(withParams('/api/v1/usage', scopedParams(query)))
}
