import type {
  HubReviewDetailDto,
  HubReviewSessionListDto,
  ReviewResponseDto,
} from '@agent-lens/protocol'

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

export async function fetchHubReviewSessions(limit = 200): Promise<HubReviewSessionListDto> {
  try {
    const response = await fetch(
      `/api/v1/hub/review?limit=${Math.max(1, Math.min(limit, 500))}`,
      { headers: { accept: 'application/json' } },
    )
    if (!response.ok) throw await responseError(response, 'Hub 会话列表读取失败')
    return response.json() as Promise<HubReviewSessionListDto>
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Hub 会话列表读取失败')) throw error
    throw new Error('Hub 会话列表读取失败，请检查 AgentLens 运行状态。')
  }
}

export async function fetchLocalReviewSessions(limit = 200): Promise<ReviewResponseDto> {
  const response = await fetch(`/api/v1/review?limit=${Math.max(1, Math.min(limit, 500))}`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw await responseError(response, '本机会话列表读取失败')
  return response.json() as Promise<ReviewResponseDto>
}
