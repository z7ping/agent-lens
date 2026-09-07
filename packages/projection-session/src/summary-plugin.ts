import type { Plugin } from '@deepseek-ai/cordis'
import type { ProjectionDefinition, ProjectionScope } from '@agent-lens/core'
import type { AgentLensContext } from '@agent-lens/runtime-cordis'

export const SESSION_SUMMARY_PROJECTION_ID = 'session-summary'
const REBUILD_DEBOUNCE_MS = 500

function logicalSessionIdFromScope(scope?: ProjectionScope): string | undefined {
  if (scope?.subjectType !== 'logical-session') return undefined
  return scope.subjectId
}

const applySessionSummaryProjection: Plugin.Function<void> = (ctx: AgentLensContext) => {
  const store = ctx.storage.sessionSummaryProjection
  if (!store) return

  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushPromise: Promise<void> | undefined
  let parserReplayDepth = 0

  const schedule = () => {
    if (parserReplayDepth > 0 || timer || flushPromise || pending.size === 0) return
    timer = setTimeout(() => {
      timer = undefined
      void flush().catch(error => {
        console.error('[AgentLens] session summary projection refresh failed', error)
      })
    }, REBUILD_DEBOUNCE_MS)
  }

  const runPending = async () => {
    while (pending.size > 0) {
      const ids = [...pending]
      pending.clear()
      for (let index = 0; index < ids.length; index += 1) {
        const logicalSessionId = ids[index]!
        const scope = { subjectType: 'logical-session', subjectId: logicalSessionId }
        try {
          ctx.emit('projection/invalidated', {
            projectionId: SESSION_SUMMARY_PROJECTION_ID,
            ...scope,
          })
          await ctx.projections.rebuild(SESSION_SUMMARY_PROJECTION_ID, scope)
        } catch (error) {
          for (const remaining of ids.slice(index)) pending.add(remaining)
          throw error
        }
      }
    }
  }

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (flushPromise) {
      await flushPromise
      if (pending.size > 0) await flush()
      return
    }
    if (pending.size === 0) return

    const current = runPending()
    flushPromise = current
    try {
      await current
    } finally {
      if (flushPromise === current) flushPromise = undefined
      schedule()
    }
  }

  const definition: ProjectionDefinition = {
    id: SESSION_SUMMARY_PROJECTION_ID,
    async rebuild(scope) {
      const logicalSessionId = logicalSessionIdFromScope(scope)
      const cancellation = scope?.signal ? { signal: scope.signal } : {}
      await store.rebuild(logicalSessionId
        ? { logicalSessionId, ...cancellation }
        : { strategy: 'cooperative', ...cancellation })
      ctx.emit('projection/rebuilt', {
        projectionId: SESSION_SUMMARY_PROJECTION_ID,
        ...(scope?.subjectType ? { subjectType: scope.subjectType } : {}),
        ...(scope?.subjectId ? { subjectId: scope.subjectId } : {}),
      })
    },
    flush,
  }

  ctx.projections.register(definition)

  ctx.on('observation/committed', event => {
    // EventingObservationService 已经过滤 unchanged；收到事件就说明 Canonical Observation
    // 有创建或合并变化，需要刷新会话摘要，覆盖 replay 后的新 provenance / metadata。
    pending.add(event.logicalSessionId)
    schedule()
  })

  ctx.on('source/parser-replay-state', event => {
    if (event.state === 'started') {
      parserReplayDepth += 1
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      return
    }
    parserReplayDepth = Math.max(0, parserReplayDepth - 1)
    schedule()
  })
}

applySessionSummaryProjection.inject = ['storage', 'projections']

export const sessionSummaryProjectionPlugin = applySessionSummaryProjection
