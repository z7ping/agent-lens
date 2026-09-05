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
    parserVersion: '14',
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

test('legacy raw reasoning is visible Thinking rather than background unknown', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'event_msg',
    payload: { type: 'agent_reasoning_raw_content', text: 'source-visible raw reasoning' },
  }, 2), ctx)

  const fact = output.observations[0]!
  assert.equal(fact.kind, 'message.reasoning')
  assert.equal((fact.payload as any).text, 'source-visible raw reasoning')
  assert.equal((fact.payload as any).rawReasoning, true)
  assert.equal((fact.payload as any).sourceSignal, 'event_msg.agent_reasoning_raw_content')
})

test('legacy response_item assistant remains readable for old Codex rollouts', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: '旧版正常回复' }],
    },
  }, 3), ctx)

  const fact = output.observations[0]!
  assert.equal(fact.kind, 'message.assistant')
  assert.equal((fact.payload as any).text, '旧版正常回复')
  assert.equal((fact.payload as any).provenance.sourceSignal, 'response_item.message.role=assistant')
})

test('response_item role=user stays in SourceRecord/Evidence but does not create a background activity', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'transport echo' }],
    },
  }, 4), ctx)

  assert.equal(output.observations.length, 0)
  assert.equal(output.evidenceCandidates.length, 1)
})

test('agent_message without visible text stays on the original unknown fallback path', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'event_msg',
    payload: { type: 'agent_message', message: '' },
  }, 5), ctx)

  assert.equal(output.observations[0]?.kind, 'unknown')
})
