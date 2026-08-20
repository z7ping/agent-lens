import type {
  HealthResponseDto,
  TimelineQueryDto,
  TimelineResponseDto,
} from '@agent-lens/protocol'

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = await response.json() as { message?: string; error?: string }
      message = body.message ?? body.error ?? message
    } catch {
      // Keep the HTTP status when an error body is not JSON.
    }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

export function getHealth(): Promise<HealthResponseDto> {
  return requestJson('/api/v1/health')
}

export function getTimeline(query: TimelineQueryDto = {}): Promise<TimelineResponseDto> {
  const params = new URLSearchParams()
  if (query.installationId) params.set('installationId', query.installationId)
  if (query.logicalSessionId) params.set('logicalSessionId', query.logicalSessionId)
  if (query.kind) params.set('kind', query.kind)
  if (query.from) params.set('from', query.from)
  if (query.to) params.set('to', query.to)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const suffix = params.size ? `?${params.toString()}` : ''
  return requestJson(`/api/v1/timeline${suffix}`)
}
