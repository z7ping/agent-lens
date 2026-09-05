import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { normalizeCurrentCodexRecord } from './current-protocol'

const ctx = {
  host: { id: 'host', name: 'host', platform: 'linux', arch: 'x64', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
  installation: { id: 'install', hostId: 'host', productId: 'codex', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
} as any

function record(entry: unknown, sourceSequence: number): SourceRecord {
  return {
    id: `r-${sourceSequence}`,
    sourceId: 'codex',
    installationId: 'install',
    sourceSessionNativeId: 'thread-root',
    nativeType: 'rollout',
    sourceSequence,
    occurredAt: '2026-09-05T06:00:00.000Z',
    capturedAt: '2026-09-05T06:00:01.000Z',
    locator: { kind: 'file', path: '/safe/rollout.jsonl', offset: sourceSequence },
    payload: { entry, session: { nativeSessionId: 'thread-root', cwd: '/safe/project' } },
    parserVersion: '13',
  }
}

test('event_msg.agent_message becomes canonical assistant output instead of background unknown', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'event_msg',
    payload: { type: 'agent_message', message: '这是正常回复', phase: 'final_answer' },
  }, 1), ctx)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'message.assistant')
  assert.equal((fact.payload as any).text, '这是正常回复')
  assert.equal((fact.payload as any).phase, 'final_answer')
  assert.equal((fact.payload as any).provenance.actualAuthor, 'assistant')
  assert.equal((fact.payload as any).provenance.contentRole, 'assistant-output')
  assert.equal((fact.payload as any).provenance.activityType, 'conversation')
  assert.equal((fact.payload as any).provenance.sourceSignal, 'event_msg.agent_message')
})

test('agent_message and response_item assistant share one structural dedup key', async () => {
  const eventMessage = await normalizeCurrentCodexRecord(record({
    type: 'event_msg',
    payload: { type: 'agent_message', message: '同一条回复', phase: 'final_answer' },
  }, 1), ctx)
  const responseItem = await normalizeCurrentCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: '同一条回复' }],
    },
  }, 2), ctx)

  const first = eventMessage.observations[0]!
  const second = responseItem.observations[0]!
  assert.equal(first.kind, 'message.assistant')
  assert.equal(second.kind, 'message.assistant')
  assert.ok(first.dedupHints?.sharedEventKey)
  assert.equal(first.dedupHints?.sharedEventKey, second.dedupHints?.sharedEventKey)
  assert.notEqual(first.dedupHints?.sourceSequence, second.dedupHints?.sourceSequence)
})
