import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectionDefinition } from '@agent-lens/core'
import type { AgentLensContext } from '@agent-lens/runtime-cordis'
import { sessionSummaryProjectionPlugin } from './summary-plugin'

test('parser replay 期间合并 Session Summary 失效通知并在完成后统一刷新', async () => {
  const handlers = new Map<string, (event: unknown) => void>()
  let definition: ProjectionDefinition | undefined
  let rebuilds = 0
  const ctx = {
    storage: { sessionSummaryProjection: {} },
    projections: {
      register(value: ProjectionDefinition) { definition = value },
      async rebuild() { rebuilds += 1 },
    },
    on(event: string, handler: (payload: unknown) => void) { handlers.set(event, handler) },
    emit() {},
  }

  sessionSummaryProjectionPlugin(ctx as unknown as AgentLensContext)
  assert.ok(definition)

  handlers.get('source/parser-replay-state')?.({ state: 'started' })
  handlers.get('observation/committed')?.({ logicalSessionId: 'session-1' })
  handlers.get('observation/committed')?.({ logicalSessionId: 'session-1' })
  await new Promise(resolve => setTimeout(resolve, 550))
  assert.equal(rebuilds, 0)

  handlers.get('source/parser-replay-state')?.({ state: 'completed' })
  await new Promise(resolve => setTimeout(resolve, 550))
  assert.equal(rebuilds, 1)
})


test('Session Summary flush 在物化完成后发布 logical-session rebuilt 事件', async () => {
  const handlers = new Map<string, (event: unknown) => void>()
  const emitted: Array<{ event: string; payload: unknown }> = []
  let definition: ProjectionDefinition | undefined
  const ctx = {
    storage: {
      sessionSummaryProjection: {
        async rebuild() {},
      },
    },
    projections: {
      register(value: ProjectionDefinition) {
        definition = value
        return { async dispose() {} }
      },
      async rebuild(_projectionId: string, scope?: unknown) {
        await definition?.rebuild(scope as never)
      },
    },
    on(event: string, handler: (payload: unknown) => void) { handlers.set(event, handler) },
    emit(event: string, payload: unknown) { emitted.push({ event, payload }) },
  }

  sessionSummaryProjectionPlugin(ctx as unknown as AgentLensContext)
  assert.ok(definition)

  handlers.get('observation/committed')?.({ logicalSessionId: 'session-ready' })
  await definition.flush?.()

  const rebuilt = emitted.find(item => item.event === 'projection/rebuilt')
  assert.deepEqual(rebuilt, {
    event: 'projection/rebuilt',
    payload: {
      projectionId: 'session-summary',
      subjectType: 'logical-session',
      subjectId: 'session-ready',
    },
  })
})
