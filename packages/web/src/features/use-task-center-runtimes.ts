import { useEffect, useSyncExternalStore } from 'react'
import type { LiveRuntimeRefDto } from '@agent-lens/protocol'
import { liveApi } from '../client/live'
import { mergeTaskLiveRuntimes, sameTaskRuntimeList, shouldRefreshRuntimeListOnVisible } from './task-live-runtime'

// 仅缓存后端导航元数据，切换工作区不清空；不持久化会话正文。
let cached: LiveRuntimeRefDto[] = []
let lastSuccessfulAt = 0
let pending: Promise<void> | undefined
let invalidatedDuringRead = false
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const getSnapshot = () => cached

async function refresh(invalidated = false): Promise<void> {
  if (pending) { invalidatedDuringRead ||= invalidated; return pending }
  pending = liveApi.knownRuntimeSnapshot().then(snapshot => {
    const next = mergeTaskLiveRuntimes(cached, snapshot.items, snapshot.failedLiveIds)
    const unchanged = sameTaskRuntimeList(cached, next) && cached.every((item, index) => {
      const other = next[index]!
      return item.historySessionId === other.historySessionId && item.projectId === other.projectId
        && item.projectName === other.projectName && item.startedAt === other.startedAt && item.lastActivityAt === other.lastActivityAt
        && JSON.stringify(item.sourceIds) === JSON.stringify(other.sourceIds)
    })
    lastSuccessfulAt = Date.now()
    if (!unchanged) {
      cached = next
      for (const listener of listeners) listener()
    }
  }).catch(() => { /* 请求失败保留已有入口，下次可见刷新重试。 */ }).finally(() => {
    pending = undefined
    if (invalidatedDuringRead) { invalidatedDuringRead = false; void refresh() }
  })
  return pending
}

export function useTaskCenterRuntimes(): readonly LiveRuntimeRefDto[] {
  const runtimes = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    let hiddenAt = document.hidden ? Date.now() : 0
    let invalidated = false
    const changed = () => {
      if (document.hidden) { invalidated = true; return }
      void refresh(true)
    }
    const visible = () => {
      if (document.hidden) { hiddenAt = Date.now(); return }
      if (shouldRefreshRuntimeListOnVisible(Date.now(), lastSuccessfulAt, hiddenAt ? Date.now() - hiddenAt : 0, invalidated)) void refresh()
      hiddenAt = 0
      invalidated = false
    }
    void refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 15_000)
    window.addEventListener('agent-lens:live-state-changed', changed)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('agent-lens:live-state-changed', changed)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
  return runtimes
}
