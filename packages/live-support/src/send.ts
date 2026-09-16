import type {
  LiveMessage,
  LiveMessageInput,
  LiveSendOptions,
} from '@agent-lens/core'
import { normalizeLiveMessage } from './message'

export interface LiveSendHandlers {
  normal(message: LiveMessage): void | Promise<void>
  steer?(message: LiveMessage): void | Promise<void>
  followUp?(message: LiveMessage): void | Promise<void>
}

export async function dispatchLiveSend(
  message: LiveMessageInput,
  options: LiveSendOptions | undefined,
  handlers: LiveSendHandlers,
): Promise<void> {
  const normalized = normalizeLiveMessage(message)
  const behavior = options?.behavior ?? 'normal'
  if (behavior === 'steer') {
    if (!handlers.steer) throw new Error('Live adapter does not support steer')
    await handlers.steer(normalized)
    return
  }
  if (behavior === 'follow-up') {
    if (!handlers.followUp) throw new Error('Live adapter does not support follow-up')
    await handlers.followUp(normalized)
    return
  }
  await handlers.normal(normalized)
}
