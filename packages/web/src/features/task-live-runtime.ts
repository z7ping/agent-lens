import type { LiveRuntimeEventDto, LiveRuntimeRefDto, LiveRuntimeStateDto } from '@agent-lens/protocol'

/** A long hidden gap can lose SSE events even without an observed connection error. */
export const LIVE_VISIBILITY_RECONCILE_WINDOW_MS = 30_000

/** Only warn while the runtime is actively streaming; silence is not proof of failure. */
export const LIVE_NO_PROGRESS_WARNING_MS = 60_000

export function shouldWarnLiveNoProgress(nowMs: number, lastProgressAtMs: number, streaming: boolean): boolean {
  return streaming && Number.isFinite(nowMs) && Number.isFinite(lastProgressAtMs)
    && lastProgressAtMs > 0 && nowMs - lastProgressAtMs >= LIVE_NO_PROGRESS_WARNING_MS
}

/** Small tab switches stay state-only; disconnections and long background gaps reconcile history. */
export function shouldRecoverLiveOnVisible(hiddenForMs: number, disconnected: boolean): boolean {
  return disconnected || hiddenForMs >= LIVE_VISIBILITY_RECONCILE_WINDOW_MS
}

export function shouldRefreshRuntimeListOnVisible(
  now: number,
  lastSuccessfulAt: number,
  hiddenForMs: number,
  invalidatedWhileHidden: boolean,
): boolean {
  return invalidatedWhileHidden
    || lastSuccessfulAt === 0
    || hiddenForMs >= LIVE_VISIBILITY_RECONCILE_WINDOW_MS
    || now - lastSuccessfulAt >= LIVE_VISIBILITY_RECONCILE_WINDOW_MS
}

export function sameLiveRuntimeState(previous: LiveRuntimeStateDto | null, next: LiveRuntimeStateDto): boolean {
  if (!previous) return false
  return previous.runtimeSessionId === next.runtimeSessionId
    && previous.status === next.status
    && previous.isStreaming === next.isStreaming
    && previous.pendingMessageCount === next.pendingMessageCount
    && previous.title === next.title
    && previous.nativeSessionId === next.nativeSessionId
    && previous.workspacePath === next.workspacePath
}

/** 将 SSE 标准事件映射到运行时快照，不依赖 React 或具体 Agent。 */
export function runtimeStateFromEvent(
  current: LiveRuntimeStateDto | null,
  envelope: LiveRuntimeEventDto,
): LiveRuntimeStateDto | null {
  if (!current || !envelope.normalizedEvent) return current
  const event = envelope.normalizedEvent
  if (event.type === 'title.update') {
    return current.title === event.title ? current : { ...current, title: event.title }
  }
  if (event.type === 'status') {
    if (event.status === 'initializing' || event.status === 'ready' || event.status === 'failed'
      || event.status === 'terminating' || event.status === 'terminated') {
      const terminal = event.status === 'failed' || event.status === 'terminating' || event.status === 'terminated'
      const nextStreaming = terminal ? false : current.isStreaming
      if (current.status === event.status && current.isStreaming === nextStreaming) return current
      return {
        ...current,
        status: event.status,
        ...(terminal ? { isStreaming: false } : {}),
      }
    }
    if (event.status === 'running') return current.isStreaming ? current : { ...current, isStreaming: true }
    if (event.status === 'idle') return current.isStreaming ? { ...current, isStreaming: false } : current
  }
  if (event.type === 'text.start' || event.type === 'text.delta'
    || event.type === 'reasoning.start' || event.type === 'reasoning.delta'
    || event.type === 'tool.start') {
    return current.isStreaming ? current : { ...current, isStreaming: true }
  }
  if (event.type === 'queue.update') {
    const pendingMessageCount = event.steering.length + event.followUp.length
    return current.pendingMessageCount === pendingMessageCount
      ? current
      : { ...current, pendingMessageCount }
  }
  if (event.type === 'completed') {
    return !current.isStreaming && current.pendingMessageCount === 0
      ? current
      : { ...current, isStreaming: false, pendingMessageCount: 0 }
  }
  return current
}

export function sameTaskRuntimeList(
  previous: readonly LiveRuntimeRefDto[],
  incoming: readonly LiveRuntimeRefDto[],
): boolean {
  return previous.length === incoming.length && previous.every((item, index) => {
    const next = incoming[index]
    return next !== undefined
      && item.liveId === next.liveId
      && item.productId === next.productId
      && item.displayName === next.displayName
      && sameLiveRuntimeState(item.state, next.state)
  })
}

export interface TaskLiveRuntimeLocation {
  liveId: string
  runtimeSessionId: string
}

export function taskLiveRuntimeHref(runtime: Pick<LiveRuntimeRefDto, 'liveId' | 'state'>): string {
  return `/review/live/${encodeURIComponent(runtime.liveId)}/${encodeURIComponent(runtime.state.runtimeSessionId)}`
}

export function parseTaskLiveRuntimeLocation(pathname: string): TaskLiveRuntimeLocation | null {
  const generic = pathname.match(/^\/review\/live\/([^/]+)\/([^/]+)$/)
  if (generic) {
    return {
      liveId: decodeURIComponent(generic[1]!),
      runtimeSessionId: decodeURIComponent(generic[2]!),
    }
  }
  const compatibility = pathname.match(/^\/review\/live\/([^/]+)$/)
  if (compatibility) {
    return {
      liveId: 'pi',
      runtimeSessionId: decodeURIComponent(compatibility[1]!),
    }
  }
  return null
}

export function taskLiveRuntimeStatus(
  state: LiveRuntimeStateDto,
): 'failed' | 'initializing' | 'terminating' | 'terminated' | 'streaming' | 'idle' {
  if (state.status === 'failed') return 'failed'
  if (state.status === 'initializing') return 'initializing'
  if (state.status === 'terminating') return 'terminating'
  if (state.status === 'terminated') return 'terminated'
  if (state.isStreaming) return 'streaming'
  return 'idle'
}


export function mergeTaskLiveRuntimes(
  previous: readonly LiveRuntimeRefDto[],
  incoming: readonly LiveRuntimeRefDto[],
  failedLiveIds: readonly string[],
): LiveRuntimeRefDto[] {
  if (!failedLiveIds.length) return [...incoming]
  const failed = new Set(failedLiveIds)
  const retained = previous.filter(item => failed.has(item.liveId))
  const next = incoming.filter(item => !failed.has(item.liveId))
  const seen = new Set(next.map(item => `${item.liveId}:${item.state.runtimeSessionId}`))
  for (const item of retained) {
    const key = `${item.liveId}:${item.state.runtimeSessionId}`
    if (!seen.has(key)) {
      seen.add(key)
      next.push(item)
    }
  }
  return next
}
