import type { LaunchableProjectsResponseDto } from '@agent-lens/protocol'

async function responseError(response: Response): Promise<Error> {
  let detail = ''
  try {
    const body = await response.json() as { message?: unknown }
    if (typeof body.message === 'string' && body.message) detail = `：${body.message}`
  } catch { /* non-json error */ }
  return new Error(`可启动项目读取失败（状态码 ${response.status}）${detail}`)
}

export async function fetchLaunchableProjects(input: {
  search?: string
  cursor?: string
  limit?: number
  signal?: AbortSignal
} = {}): Promise<LaunchableProjectsResponseDto> {
  const params = new URLSearchParams()
  const search = input.search?.trim()
  if (search) params.set('search', search)
  if (input.cursor) params.set('cursor', input.cursor)
  params.set('limit', String(Math.max(1, Math.min(input.limit ?? 20, 50))))

  try {
    const response = await fetch(`/api/v1/projects/launchable?${params}`, {
      headers: { accept: 'application/json' },
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (!response.ok) throw await responseError(response)
    return response.json() as Promise<LaunchableProjectsResponseDto>
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    if (error instanceof Error && error.message.startsWith('可启动项目读取失败')) throw error
    throw new Error('可启动项目读取失败，请检查 AgentLens 运行状态。')
  }
}
