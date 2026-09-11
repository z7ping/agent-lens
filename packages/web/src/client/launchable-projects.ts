import type { LaunchableProjectsResponseDto } from '@agent-lens/protocol'
import { translateProduct } from '../i18n/runtime'

class LaunchableProjectsRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LaunchableProjectsRequestError'
  }
}

async function responseError(response: Response): Promise<Error> {
  let detail = ''
  try {
    const body = await response.json() as { message?: unknown }
    if (typeof body.message === 'string' && body.message) detail = `：${body.message}`
  } catch { /* non-json error */ }
  return new LaunchableProjectsRequestError(translateProduct('errors:launchableProjectsStatus', { status: response.status, detail }))
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
    if (error instanceof LaunchableProjectsRequestError) throw error
    throw new LaunchableProjectsRequestError(translateProduct('errors:launchableProjectsFailed'))
  }
}
