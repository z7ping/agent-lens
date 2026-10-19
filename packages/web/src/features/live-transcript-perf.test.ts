import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveTaskProjectionItem } from './live-task-projection'
import { LiveTaskRoundProjector, LIVE_TASK_ROUND_FACT_LIMIT, projectLiveTaskRounds } from './live-task-projection'
import { liveFollowTextRevision } from './live-follow-controller'

/** Deterministic long-session fixture; no timing threshold tied to CI host speed. */
function transcript(rounds = 120, toolsPerRound = 10): LiveTaskProjectionItem[] {
  const items: LiveTaskProjectionItem[] = []
  for (let round = 1; round <= rounds; round += 1) {
    items.push({
      id: `user:${round}`, kind: 'message', role: 'user',
      text: `round ${round}`, streaming: false,
    })
    for (let tool = 1; tool <= toolsPerRound; tool += 1) {
      items.push({
        id: `tool:${round}:${tool}`, kind: 'tool',
        callId: `call:${round}:${tool}`, name: 'shell',
        status: 'success', output: 'ok',
      })
    }
  }
  return items
}

test('100+ 轮与 1000+ 工具保留有序导轨语义和有界虚拟分块', () => {
  const items = transcript()
  const segments = projectLiveTaskRounds(items)
  const semantic = [...new Set(segments.map(round => round.model.semanticId))]
  assert.equal(semantic.length, 120)
  assert.equal(items.filter(item => item.kind === 'tool').length, 1200)
  assert.equal(semantic[0], 'live-round:user:1')
  assert.equal(semantic.at(-1), 'live-round:user:120')
  assert.ok(segments.every(round => round.items.length <= LIVE_TASK_ROUND_FACT_LIMIT))
  assert.ok(segments.every(round => round.model.ordinal !== undefined))
})

test('100+ 轮稳定历史不因当前正文与折叠工具变化重新投影', () => {
  const items = transcript()
  const stable = items.slice(0, 119 * 11)
  const active = items.slice(119 * 11)
  const projector = new LiveTaskRoundProjector()
  const before = projector.projectSegmented(stable, active)
  const during = projector.projectSegmented(stable, [
    ...active,
    { id: 'assistant:last', kind: 'message', role: 'assistant', text: '分析中', streaming: true },
  ])
  assert.strictEqual(before.stable, during.stable)
  assert.equal(before.stable.length, 238)
  assert.equal(during.active.at(-1)?.model.ordinal, 120)
  const revision = liveFollowTextRevision(stable, during.active.flatMap(round => round.items))
  const noisy = liveFollowTextRevision(stable, [
    ...active,
    { id: 'assistant:last', kind: 'message', role: 'assistant', text: '分析中', streaming: true },
    { id: 'tool:extra', kind: 'tool', callId: 'extra', name: 'shell', status: 'running', output: 'x'.repeat(8000) },
  ])
  assert.equal(revision, noisy, '折叠内部增长不得触发正文自动跟随')
})
