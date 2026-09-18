import type {
  PiEcosystemPackageDetailsRequestDto,
  PiEcosystemPackageDetailsResponseDto,
  PiEcosystemSearchRequestDto,
  PiEcosystemSearchResponseDto,
} from '@agent-lens/protocol'
import { AgentLensRequestError } from './api'
import { translateProduct } from '../i18n/runtime'

function responseErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const message = Reflect.get(value, 'message')
  return typeof message === 'string' && message ? message : undefined
}

async function readResponse<T>(path: string, signal?: AbortSignal): Promise<T> {
  try {
    const response = await fetch(path, {
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) {
      let detail = ''
      try {
        const message = responseErrorMessage(await response.json())
        if (message) detail = `：${message}`
      } catch { /* non-json error */ }
      throw new AgentLensRequestError(
        translateProduct('errors:apiRequestFailedStatus', { status: response.status, detail, path }),
        response.status,
      )
    }
    return response.json() as Promise<T>
  } catch (error) {
    if (error instanceof AgentLensRequestError || (error instanceof DOMException && error.name === 'AbortError')) {
      throw error
    }
    throw new AgentLensRequestError(translateProduct('errors:apiRequestFailed'))
  }
}

export async function searchPiEcosystem(
  request: PiEcosystemSearchRequestDto = {},
  signal?: AbortSignal,
): Promise<PiEcosystemSearchResponseDto> {
  const params = new URLSearchParams()
  const query = request.query?.trim()
  if (query) params.set('query', query)
  if (request.type) params.set('type', request.type)
  if (request.sort) params.set('sort', request.sort)
  if (request.limit) params.set('limit', String(request.limit))
  const suffix = params.size ? `?${params}` : ''
  return readResponse<PiEcosystemSearchResponseDto>(
    `/api/v1/integrations/pi/ecosystem${suffix}`,
    signal,
  )
}

export async function loadPiEcosystemPackageDetails(
  request: PiEcosystemPackageDetailsRequestDto,
  signal?: AbortSignal,
): Promise<PiEcosystemPackageDetailsResponseDto> {
  const params = new URLSearchParams({
    name: request.packageName,
    version: request.version,
  })
  return readResponse<PiEcosystemPackageDetailsResponseDto>(
    `/api/v1/integrations/pi/ecosystem/package?${params}`,
    signal,
  )
}
