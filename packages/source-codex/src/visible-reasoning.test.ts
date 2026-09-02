import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { normalizeCodexRecord } from './normalize'

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
    parserVersion: '7',
  }
}

test('assistant commentary keeps its visible execution phase', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: '先检查实际启动链路。' }],
    },
  }), ctx)

  const fact = output.observations[0]!
  assert.equal(fact.kind, 'message.commentary')
  assert.equal((fact.payload as any).text, '先检查实际启动链路。')
  assert.equal((fact.payload as any).phase, 'commentary')
})

test('event_msg agent_reasoning is normalized to canonical message.reasoning', async () => {
  const output = await normalizeCodexRecord(record({
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

test('reasoning_summary supports structured summary blocks', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'event_msg',
    payload: {
      type: 'reasoning_summary',
      summary: [
        { type: 'summary_text', text: 'Check parser state.' },
        { type: 'summary_text', text: 'Then inspect projection.' },
      ],
    },
  }), ctx)

  const fact = output.observations[0]!
  assert.equal(fact.kind, 'message.reasoning')
  assert.equal((fact.payload as any).text, 'Check parser state.\n\nThen inspect projection.')
})

test('reasoning token statistics are not promoted to Thinking text', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { output_tokens: 20, reasoning_output_tokens: 12 } },
    },
  }), ctx)

  assert.equal(output.observations[0]?.kind, 'usage')
})

test('non-reasoning event_msg keeps original normalization', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'event_msg',
    payload: { type: 'turn_started', turn_id: 'turn-1' },
  }), ctx)

  assert.equal(output.observations[0]?.kind, 'session.lifecycle')
})
