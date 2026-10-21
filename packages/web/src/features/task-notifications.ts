import { useSyncExternalStore } from 'react'
import type { LiveRuntimeEventDto } from '@agent-lens/protocol'
import { translateProduct } from '../i18n/runtime'

/** Lightweight notification metadata only: never replicate native conversation payloads. */
export type TaskNotificationLevel = 'info' | 'success' | 'warning' | 'error' | 'action'
export interface TaskNotification {
  id: string
  liveId: string
  runtimeSessionId: string
  level: TaskNotificationLevel
  title: string
  message: string
  receivedAt: string
  read: boolean
}

export interface TaskNotificationSnapshot {
  items: readonly TaskNotification[]
  bannerId: string | null
}

const STORAGE_KEY = 'agent-lens.task-notifications.v1'
const MAX_NOTIFICATIONS = 100
const listeners = new Set<() => void>()

function readStored(): TaskNotification[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(value)) return []
    return value.filter((item): item is TaskNotification => Boolean(item)
      && typeof item === 'object' && typeof item.id === 'string'
      && typeof item.liveId === 'string' && typeof item.runtimeSessionId === 'string'
      && typeof item.title === 'string' && typeof item.message === 'string'
      && typeof item.receivedAt === 'string' && typeof item.read === 'boolean'
      && ['info', 'success', 'warning', 'error', 'action'].includes(item.level))
      .slice(0, MAX_NOTIFICATIONS)
  } catch { return [] }
}
let snapshot: TaskNotificationSnapshot = { items: readStored(), bannerId: null }

function publish(next: TaskNotificationSnapshot): void {
  snapshot = next
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next.items)) } catch { /* Privacy mode can reject writes. */ }
  for (const listener of listeners) listener()
}

export const taskNotifications = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getSnapshot: () => snapshot,
  push(item: TaskNotification) {
    if (snapshot.items.some(existing => existing.id === item.id)) return
    publish({
      items: [item, ...snapshot.items].slice(0, MAX_NOTIFICATIONS),
      bannerId: item.level === 'info' ? snapshot.bannerId : item.id,
    })
  },
  markRead(id: string) {
    if (!snapshot.items.some(item => item.id === id && !item.read)) return
    publish({ ...snapshot, items: snapshot.items.map(item => item.id === id ? { ...item, read: true } : item) })
  },
  markAllRead() {
    if (!snapshot.items.some(item => !item.read)) return
    publish({ ...snapshot, items: snapshot.items.map(item => ({ ...item, read: true })) })
  },
  dismissBanner(id: string) {
    if (snapshot.bannerId === id) publish({ ...snapshot, bannerId: null })
  },
}

export function useTaskNotifications(): TaskNotificationSnapshot {
  return useSyncExternalStore(taskNotifications.subscribe, taskNotifications.getSnapshot)
}

export interface TaskNativeNotificationEnvelope {
  liveId: string
  runtimeSessionId: string
  event: LiveRuntimeEventDto
}

/** Only native notifications, native errors/approval requests and completed off-screen turns. */
export function projectTaskNotification(
  value: TaskNativeNotificationEnvelope,
  focusedRuntimeHref: string,
): TaskNotification | null {
  const { liveId, runtimeSessionId, event: envelope } = value
  if (!liveId || !runtimeSessionId || !Number.isSafeInteger(envelope.sequence)) return null
  const event = envelope.normalizedEvent
  if (!event) return null
  const href = `/review/live/${encodeURIComponent(liveId)}/${encodeURIComponent(runtimeSessionId)}`
  const focused = focusedRuntimeHref === href
  let level: TaskNotificationLevel
  let title: string
  let message: string
  let nativeId = String(envelope.sequence)
  if (event.type === 'notification') {
    level = event.level
    title = event.title || ''
    message = event.message
    nativeId = event.id || nativeId
  } else if (event.type === 'ui.request') {
    level = 'action'
    title = event.title || ''
    message = event.message || translateProduct('task:notifications.waitingApproval')
    nativeId = event.requestId
  } else if (event.type === 'error') {
    level = 'error'
    title = ''
    message = event.message
  } else if (event.type === 'completed') {
    // A finished foreground turn already has its own answer. Notify only when
    // another runtime finished while the reader was elsewhere.
    if (focused || (event.status !== 'completed' && event.status !== 'failed')) return null
    level = event.status === 'failed' ? 'error' : 'success'
    title = ''
    message = event.message || (event.status === 'failed' ? 'Task failed' : 'Turn completed')
  } else return null
  if (!message.trim()) return null
  return {
    id: `${liveId}:${runtimeSessionId}:${nativeId}`,
    liveId, runtimeSessionId, level, title: title.slice(0, 120),
    message: message.slice(0, 2000),
    receivedAt: envelope.receivedAt, read: false,
  }
}

export function installTaskNotificationMonitor(): () => void {
  const source = new EventSource('/api/v1/live/notifications/events')
  const onNotification = (incoming: Event) => {
    try {
      const envelope = JSON.parse((incoming as MessageEvent<string>).data) as TaskNativeNotificationEnvelope
      const item = projectTaskNotification(envelope, window.location.pathname)
      if (item) taskNotifications.push(item)
    } catch { /* A malformed source event cannot break the notification center. */ }
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return
    snapshot = { ...snapshot, items: readStored() }
    for (const listener of listeners) listener()
  }
  source.addEventListener('notification', onNotification)
  window.addEventListener('storage', onStorage)
  return () => {
    source.removeEventListener('notification', onNotification)
    window.removeEventListener('storage', onStorage)
    source.close()
  }
}
