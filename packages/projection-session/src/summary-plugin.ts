import type { SessionSummaryProjectionStore, StorageService } from '@agent-lens/core'
import type { Context } from 'cordis'
import { SESSION_SUMMARY_PROJECTION_ID } from './constants'

export interface SessionSummaryProjectionPluginServices {
  storage: StorageService
  projections: {
    register(definition: {
      id: string
      rebuild(scope?: { subjectType?: string; subjectId?: string; signal?: AbortSignal }): Promise<void>
      flush?(): Promise<void>
    }): { dispose(): void }
  }
}

function logicalSessionIdFromScope(scope?: { subjectType?: string; subjectId?: string }): string | undefined {
  return scope?.subjectType === 'logical-session' && scope.subjectId ? scope.subjectId : undefined
}

export async function applySessionSummaryProjection(ctx: Context & SessionSummaryProjectionPluginServices): Promise<void> {
  const store = ctx.storage.sessionSummaryProjection as SessionSummaryProjectionStore | undefined
  if (!store) return

  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let draining = false

  const rebuildPending = async () => {
    if (draining || !pending.size) return
    draining = true
    try {
      while (pending.size) {
        const batch = [...pending]
        pending.clear()
        for (const logicalSessionId of batch) {
          await store.rebuild({ logicalSessionId })
        }
      }
    } finally {
      draining = false
    }
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void rebuildPending()
    }, 25)
  }

  const flush = async () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    await rebuildPending()
  }

  const definition = {
    id: SESSION_SUMMARY_PROJECTION_ID,
    async rebuild(scope?: { subjectType?: string; subjectId?: string; signal?: AbortSignal }) {
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
    pending.add(event.logicalSessionId)
    schedule()
  })
}

applySessionSummaryProjection.inject = ['storage', 'projections']

export const sessionSummaryProjectionPlugin = applySessionSummaryProjection