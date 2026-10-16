import type { LiveMessageDto, LiveQueueStateDto } from '@agent-lens/protocol'
import type { LiveTaskProjectionItem } from './live-task-projection'

/** 输入队列与恢复草稿的纯数据策略。 */
export type LiveQueueMode = 'steer' | 'follow-up'
export type PendingQueueSubmission = { id: string; mode: LiveQueueMode; text: string }
export type RestoredQueueDraft = { id: string; mode: LiveQueueMode; text: string }
export type LiveQueueListItem = {
  id: string
  mode: LiveQueueMode
  text: string
  active: boolean
  pending?: boolean | undefined
  queueIndex?: number | undefined
}

export function emptyLiveQueue(): LiveQueueStateDto {
  return { steering: [], followUp: [] }
}

export function restoredQueueDrafts(queue: LiveQueueStateDto): RestoredQueueDraft[] {
  const stamp = Date.now()
  return [
    ...queue.steering.map((text, index) => ({ id: `steer-${stamp}-${index}`, mode: 'steer' as const, text })),
    ...queue.followUp.map((text, index) => ({ id: `follow-${stamp}-${index}`, mode: 'follow-up' as const, text })),
  ]
}

export function queueTextMessage(text: string): LiveMessageDto {
  return { parts: [{ type: 'text', text }] }
}

export function firstUserEntryCursor(items: readonly LiveTaskProjectionItem[]): string | undefined {
  return items.find(
    (item): item is Extract<LiveTaskProjectionItem, { kind: 'message' }> =>
      item.kind === 'message' && item.role === 'user' && Boolean(item.entryId),
  )?.entryId
}

