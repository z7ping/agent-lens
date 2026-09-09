import type { BackgroundActivityResponseDto } from '@agent-lens/protocol'

export async function fetchBackgroundActivity(signal?: AbortSignal): Promise<BackgroundActivityResponseDto> {
  let response: Response
  try {
    response = await fetch('/api/v1/background-activity', {
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error('后台活动状态暂时不可用')
  }
  if (!response.ok) throw new Error(`后台活动状态请求失败（${response.status}）`)
  return response.json() as Promise<BackgroundActivityResponseDto>
}
