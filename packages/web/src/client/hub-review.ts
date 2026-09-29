import type {
  HubReviewDetailDto,
  HubReviewSessionListDto,
  ReviewResponseDto,
} from '@agent-lens/protocol'
import { translateProduct } from '../i18n/runtime'
import { shareInFlight } from './single-flight'

const HUB_SESSION_CACHE_MS = 10_000
const hubSessionCache = new Map<number, { at: number; value: HubReviewSessionListDto }>()
const hubSessionInFlight = new Map<number, Promise<HubReviewSessionListDto>>()
const hubDetailInFlight = new Map<string, Promise<unknown>>()
const localReviewInFlight = new Map<string, Promise<unknown>>()

class HubReviewRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HubReviewRequestError'
  }
}

async function responseError(response: Response, label: string): Promise<Error> {
  let detail = ''
  try {
    const body = await response.json() as { message?: unknown }
    if (typeof body.message === 'string' && body.message) detail = `：${body.message}`
  } catch { /* non-json error */ }
  return new HubReviewRequestError(translateProduct('errors:labeledRequestStatus', { label, status: response.status, detail }))
}

export function fetchHubReviewDetail(id: string, limit = 500): Promise<HubReviewDetailDto> {
  const normalizedLimit = Math.max(1, Math.min(limit, 500))
  const path = `/api/v1/hub/review/${encodeURIComponent(id)}?limit=${normalizedLimit}`
  return shareInFlight(hubDetailInFlight, path, async () => {
    try {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      if (!response.ok) throw await responseError(response, translateProduct('errors:remoteReviewLabel'))
      return await response.json() as HubReviewDetailDto
    } catch (error) {
      if (error instanceof HubReviewRequestError) throw error
      throw new HubReviewRequestError(translateProduct('errors:remoteReviewFailed'))
    }
  })
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
      if (!response.ok) throw await responseError(response, translateProduct('errors:hubSessionsLabel'))
      const value = await response.json() as HubReviewSessionListDto
      hubSessionCache.set(normalizedLimit, { at: Date.now(), value })
      return value
    } catch (error) {
      if (error instanceof HubReviewRequestError) throw error
      throw new HubReviewRequestError(translateProduct('errors:hubSessionsFailed'))
    } finally {
      hubSessionInFlight.delete(normalizedLimit)
    }
  })()
  hubSessionInFlight.set(normalizedLimit, request)
  return request
}

export function fetchLocalReviewSessions(limit = 200): Promise<ReviewResponseDto> {
  const normalizedLimit = Math.max(1, Math.min(limit, 500))
  const path = `/api/v1/review?limit=${normalizedLimit}`
  return shareInFlight(localReviewInFlight, path, async () => {
    const response = await fetch(path, { headers: { accept: 'application/json' } })
    if (!response.ok) throw await responseError(response, translateProduct('errors:localSessionsLabel'))
    return await response.json() as ReviewResponseDto
  })
}
