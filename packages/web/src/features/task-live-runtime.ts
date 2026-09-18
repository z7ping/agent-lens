import type { LiveRuntimeRefDto, LiveRuntimeStateDto } from '@agent-lens/protocol'

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
