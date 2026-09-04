import type {
  HubReviewDetailDto,
  HubReviewSessionListDto,
  ReviewResponseDto,
} from '@agent-lens/protocol'

const HUB_SESSION_CACHE_MS = 10_000
const hubSessionCache = new Map<number, { at: number; value: HubReviewSessionListDto }>()
const hubSessionInFlight = new Map<number, Promise<HubReviewSessionListDto>>()

async function responseError(response: Response, label: string): Promise<Error> {
  let detail = ''
  try {
    const body = await response.json() as { message?: unknown }
    if (typeof body.message === 'string' && body.message) detail = `：${body.message}`
  } catch { /* non-json error */ }
  return new Error(`${label}（状态码 ${response.status}）${detail}`)
}

export async function fetchHubReviewDetail(id: string, limit = 500): Promise<HubReviewDetailDto> {
  try {
    const response = await fetch(
      `/api/v1/hub/review/${encodeURIComponent(id)}?limit=${Math.max(1, Math.min(limit, 500))}`,
      { headers: { accept: 'application/json' } },
    )
    if (!response.ok) throw await responseError(response, '远程复盘读取失败')
    return response.json() as Promise<HubReviewDetailDto>
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('远程复盘读取失败')) throw error
    throw new Error('远程复盘读取失败，请检查 AgentLens 运行状态。')
  }
}

export async function fetchHubReviewSessions(limit = 200, force = false): Promise<HubReviewSessionListDto> {
  const normalizedLimit = Math.max(1, Math.min(limit, 500))
  const cached = hubSessionCache.get(normalizedLimit)
  if (!force && cached && Date.now() - cached.at < HUB_SESSION_CACHE_MS) return cached.value
  const pending = hubSessionInFlight.get(normalizedLimit)
  if (pending) return pending

  const request = (async () => {
    try {
      const response = await fetch(
        `/api/v1/hub/review?limit=${normalizedLimit}`,
        { headers: { accept: 'application/json' } },
      )
      if (!response.ok) throw await responseError(response, 'Hub 会话列表读取失败')
      const value = await response.json() as HubReviewSessionListDto
      hubSessionCache.set(normalizedLimit, { at: Date.now(), value })
      return value
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Hub 会话列表读取失败')) throw error
      throw new Error('Hub 会话列表读取失败，请检查 AgentLens 运行状态。')
    } finally {
      hubSessionInFlight.delete(normalizedLimit)
    }
  })()
  hubSessionInFlight.set(normalizedLimit, request)
  return request
}

export async function fetchLocalReviewSessions(limit = 200): Promise<ReviewResponseDto> {
  const response = await fetch(`/api/v1/review?limit=${Math.max(1, Math.min(limit, 500))}`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw await responseError(response, '本机会话列表读取失败')
  return response.json() as Promise<ReviewResponseDto>
}
