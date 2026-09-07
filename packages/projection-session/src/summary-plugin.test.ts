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
