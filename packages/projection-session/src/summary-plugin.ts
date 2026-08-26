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
  }

  ctx.projections.register(definition)

  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushing = false

  const flush = async () => {
    if (flushing || pending.size === 0) return
    flushing = true
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    const ids = [...pending]
    pending.clear()
    try {
      for (const logicalSessionId of ids) {
        const scope = { subjectType: 'logical-session', subjectId: logicalSessionId }
        ctx.emit('projection/invalidated', {
          projectionId: SESSION_SUMMARY_PROJECTION_ID,
          ...scope,
        })
        await ctx.projections.rebuild(SESSION_SUMMARY_PROJECTION_ID, scope)
      }
    } catch (error) {
      console.error('[AgentLens] session summary projection refresh failed', error)
    } finally {
      flushing = false
      if (pending.size > 0 && !timer) {
        timer = setTimeout(() => void flush(), REBUILD_DEBOUNCE_MS)
      }
    }
  }

  ctx.on('observation/committed', event => {
    if (event.status !== 'created') return
    pending.add(event.logicalSessionId)
    if (!timer) timer = setTimeout(() => void flush(), REBUILD_DEBOUNCE_MS)
  })
}

applySessionSummaryProjection.inject = ['storage', 'projections']

export const sessionSummaryProjectionPlugin = applySessionSummaryProjection
