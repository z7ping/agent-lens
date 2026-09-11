import type { LiveSendOptions } from '@agent-lens/core'

export interface LiveSendHandlers {
  normal(message: string): void | Promise<void>
  steer?(message: string): void | Promise<void>
  followUp?(message: string): void | Promise<void>
}

export async function dispatchLiveSend(
  message: string,
  options: LiveSendOptions | undefined,
  handlers: LiveSendHandlers,
): Promise<void> {
  const behavior = options?.behavior ?? 'normal'
  if (behavior === 'steer') {
    if (!handlers.steer) throw new Error('Live adapter does not support steer')
    await handlers.steer(message)
    return
  }
  if (behavior === 'follow-up') {
    if (!handlers.followUp) throw new Error('Live adapter does not support follow-up')
    await handlers.followUp(message)
    return
  }
  await handlers.normal(message)
}
