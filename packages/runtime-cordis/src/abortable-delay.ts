import { setTimeout as delay } from 'node:timers/promises'

export async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  try {
    await delay(ms, undefined, { signal })
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return
    throw error
  }
}
