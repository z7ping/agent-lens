import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultProjectionService } from '@agent-lens/core-services'
import type { AgentLensContext } from '@agent-lens/runtime-cordis'
import { sessionSummaryProjectionPlugin } from './summary-plugin'

function createContext(
  projections: DefaultProjectionService,
  handlers = new Map<string, (event: unknown) => void>(),
  onRebuild: () => void = () => {},
): AgentLensContext {
  return {
    storage: {
      sessionSummaryProjection: {
        async isMaterialized() { return true },
        async rebuild() { onRebuild() },
        async query() { return { items: [], hasMore: false } },
      },
    },
    projections,
    on(event: string, handler: (payload: unknown) => void) { handlers.set(event, handler) },
    emit() {},
  } as unknown as AgentLensContext
}

test('Session Summary dispose 会取消待执行的 debounce 刷新', async () => {
  const handlers = new Map<string, (event: unknown) => void>()
  let rebuilds = 0
  const ctx = createContext(new DefaultProjectionService(), handlers, () => { rebuilds += 1 })

  const dispose = sessionSummaryProjectionPlugin(ctx) as unknown as (() => void | Promise<void>) | undefined
  handlers.get('observation/committed')?.({ logicalSessionId: 'session-dispose' })
  await dispose?.()
  await new Promise(resolve => setTimeout(resolve, 550))

  assert.equal(rebuilds, 0)
})

test('Session Summary dispose 会注销 Projection，允许同 ID 再注册', async () => {
  const projections = new DefaultProjectionService()
  const first = sessionSummaryProjectionPlugin(createContext(projections)) as unknown as (() => void | Promise<void>) | undefined

  await first?.()

  const second = sessionSummaryProjectionPlugin(createContext(projections)) as unknown as (() => void | Promise<void>) | undefined
  assert.ok(second)
  await second?.()
})
