import type { HubReviewDetailDto } from '@agent-lens/protocol'

export async function fetchHubReviewDetail(id: string, limit = 500): Promise<HubReviewDetailDto> {
  try {
    const response = await fetch(
      `/api/v1/hub/review/${encodeURIComponent(id)}?limit=${Math.max(1, Math.min(limit, 500))}`,
      { headers: { accept: 'application/json' } },
    )
    if (!response.ok) {
      let detail = ''
      try {
        const body = await response.json() as { message?: unknown }
        if (typeof body.message === 'string' && body.message) detail = `：${body.message}`
      } catch { /* non-json error */ }
      throw new Error(`远程复盘读取失败（状态码 ${response.status}）${detail}`)
    }
    return response.json() as Promise<HubReviewDetailDto>
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('远程复盘读取失败')) throw error
    throw new Error('远程复盘读取失败，请检查 AgentLens 运行状态。')
  }
}
