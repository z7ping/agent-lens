import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { normalizeCodexRecordWithVisibleReasoning } from './normalize-visible-reasoning'

const ctx = {
  host: { id: 'host', name: 'host', platform: 'linux', arch: 'x64', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
  installation: { id: 'install', hostId: 'host', productId: 'codex', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
} as any

function record(entry: unknown): SourceRecord {
  return {
    id: 'codex-visible-reasoning',
    sourceId: 'codex',
    installationId: 'install',
    sourceSessionNativeId: 'thread-visible',
    nativeType: 'event_msg',
    sourceSequence: 7,
    capturedAt: '2026-09-01T00:00:00.000Z',
    locator: { kind: 'file', path: '/safe/rollout.jsonl', offset: 42 },
    payload: { entry, session: { nativeSessionId: 'thread-visible', cwd: '/safe/project' } },
    parserVersion: '6',
  }
}

test('event_msg agent_reasoning is promoted to canonical message.reasoning', async () => {
  const output = await normalizeCodexRecordWithVisibleReasoning(record({
    type: 'event_msg',
    payload: {
      type: 'agent_reasoning',
      text: 'Inspect the runtime chain before changing code.',
      phase: 'analysis',
    },
  }), ctx)

  const fact = output.observations[0]!
  assert.equal(fact.kind, 'message.reasoning')
  assert.equal((fact.payload as any).text, 'Inspect the runtime chain before changing code.')
  assert.equal((fact.payload as any).raw.phase, 'analysis')
  assert.equal(fact.sourceSequence, 7)
})

test('non-reasoning event_msg keeps original normalization', async () => {
  const output = await normalizeCodexRecordWithVisibleReasoning(record({
    type: 'event_msg',
    payload: { type: 'turn_started', turn_id: 'turn-1' },
  }), ctx)

  assert.equal(output.observations[0]?.kind, 'session.lifecycle')
})
