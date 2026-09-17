import type { LiveRuntimeRefDto, LiveRuntimeStateDto } from '@agent-lens/protocol'

export interface TaskLiveRuntimeLocation {
  liveId: string
  runtimeSessionId: string
}

export function taskLiveRuntimeHref(runtime: Pick<LiveRuntimeRefDto, 'liveId' | 'state'>): string {
  const runtimeSessionId = encodeURIComponent(runtime.state.runtimeSessionId)
  return runtime.liveId === 'pi'
    ? `/review/live/${runtimeSessionId}`
    : `/review/live/${encodeURIComponent(runtime.liveId)}/${runtimeSessionId}`
}

export function parseTaskLiveRuntimeLocation(pathname: string): TaskLiveRuntimeLocation | null {
  const generic = pathname.match(/^\/review\/live\/([^/]+)\/([^/]+)$/)
  if (generic) {
    return {
      liveId: decodeURIComponent(generic[1]!),
      runtimeSessionId: decodeURIComponent(generic[2]!),
    }
  }
  const piCompatibility = pathname.match(/^\/review\/live\/([^/]+)$/)
  if (piCompatibility) {
    return {
      liveId: 'pi',
      runtimeSessionId: decodeURIComponent(piCompatibility[1]!),
    }
  }
  return null
}

export function taskLiveRuntimeStatus(
  state: LiveRuntimeStateDto,
): 'failed' | 'initializing' | 'streaming' | 'idle' {
  if (state.status === 'failed') return 'failed'
  if (state.status === 'initializing') return 'initializing'
  if (state.isStreaming) return 'streaming'
  return 'idle'
}
