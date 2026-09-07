import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProjectionDefinition } from '@agent-lens/core'
import type { AgentLensContext } from '@agent-lens/runtime-cordis'
import { sessionSummaryProjectionPlugin } from './summary-plugin'

test('Session Summary dispose 会取消待执行的 debounce 刷新', async () => {
  const handlers = new Map<string, (event: unknown) => void>()
  let rebuilds = 0
  const ctx = {
    storage: { sessionSummaryProjection: {} },
    projections: {
      register(_value: ProjectionDefinition) {},
      async rebuild() { rebuilds += 1 },
    },
    on(event: string, handler: (payload: unknown) => void) { handlers.set(event, handler) },
    emit() {},
  }

  const dispose = sessionSummaryProjectionPlugin(ctx as unknown as AgentLensContext) as unknown as (() => void | Promise<void>) | undefined
  handlers.get('observation/committed')?.({ logicalSessionId: 'session-dispose' })
  await dispose?.()
  await new Promise(resolve => setTimeout(resolve, 550))

  assert.equal(rebuilds, 0)
})
