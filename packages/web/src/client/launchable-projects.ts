import type { LaunchableProjectsResponseDto } from '@agent-lens/protocol'
import { translateProduct } from '../i18n/runtime'
import { shareInFlight, waitForCaller } from './single-flight'

const launchableProjectsInFlight = new Map<string, Promise<unknown>>()
const PROJECT_PAGE_CACHE_TTL_MS = 60_000
let initialProjectPage: { value: LaunchableProjectsResponseDto; loadedAt: number } | undefined

// 仅复用默认首页；搜索和后续游标必须始终对应各自的服务端结果。
export function cachedLaunchableProjects(): LaunchableProjectsResponseDto | undefined {
  if (!initialProjectPage || Date.now() - initialProjectPage.loadedAt > PROJECT_PAGE_CACHE_TTL_MS) return undefined
  return initialProjectPage.value
}

export function prefetchLaunchableProjects(): void {
  if (cachedLaunchableProjects()) return
  void fetchLaunchableProjects().catch(() => undefined)
}

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

  const path = `/api/v1/projects/launchable?${params}`
  const pending = shareInFlight(
    launchableProjectsInFlight,
    path,
    async () => {
      try {
        const response = await fetch(path, {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) throw await responseError(response)
        const value = await response.json() as LaunchableProjectsResponseDto
        if (!search && !input.cursor && params.get('limit') === '20') {
          initialProjectPage = value.items.length > 0 ? { value, loadedAt: Date.now() } : undefined
        }
        return value
      } catch (error) {
        if (error instanceof LaunchableProjectsRequestError) throw error
        throw new LaunchableProjectsRequestError(translateProduct('errors:launchableProjectsFailed'))
      }
    },
  )
  return waitForCaller(pending, input.signal)
}
