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

  const schedule = () => {
    if (timer || flushPromise || pending.size === 0) return
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
      await store.rebuild(logicalSessionId ? { logicalSessionId } : {})
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
    if (event.status !== 'created') return
    pending.add(event.logicalSessionId)
    schedule()
  })
}

applySessionSummaryProjection.inject = ['storage', 'projections']

export const sessionSummaryProjectionPlugin = applySessionSummaryProjection
