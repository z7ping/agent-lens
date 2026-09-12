import type { BackgroundActivityResponseDto } from '@agent-lens/protocol'
import { translateProduct } from '../i18n/runtime'

export async function fetchBackgroundActivity(signal?: AbortSignal): Promise<BackgroundActivityResponseDto> {
  let response: Response
  try {
    response = await fetch('/api/v1/background-activity', {
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error(translateProduct('errors:backgroundActivityUnavailable'))
  }
  if (!response.ok) throw new Error(translateProduct('errors:backgroundActivityFailed', { status: response.status }))
  return response.json() as Promise<BackgroundActivityResponseDto>
}
