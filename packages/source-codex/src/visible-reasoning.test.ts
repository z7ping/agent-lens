import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { normalizeCodexRecord, splitCodexVisibleAssistantText } from './normalize'
import { asRecord, codexTestContext } from './test-support'

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
  }), codexTestContext)

  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  assert.equal(fact.kind, 'message.commentary')
  assert.equal(payload.text, '先检查实际启动链路。')
  assert.equal(payload.phase, 'commentary')
})

test('assistant final_answer separates trailing memory citation metadata', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: '已完成。\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[test]\n</citation_entries>\n<rollout_ids>\nrollout-1\n</rollout_ids>\n</oai-mem-citation>' }],
    },
  }), codexTestContext)

  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  assert.equal(fact.kind, 'message.assistant')
  assert.equal(payload.text, '已完成。')
  assert.deepEqual(payload.sourceMetadata, [{ kind: 'memory.citation' }])
  assert.equal('content' in payload, false)
})

test('memory citation text remains visible outside assistant final_answer', () => {
  const quoted = '<oai-mem-citation>\n<citation_entries>x</citation_entries>\n<rollout_ids>y</rollout_ids>\n</oai-mem-citation>'
  assert.equal(splitCodexVisibleAssistantText(quoted, 'commentary').text, quoted)
  assert.equal(splitCodexVisibleAssistantText(`\`\`\`xml\n${quoted}\n\`\`\``, 'final_answer').text, `\`\`\`xml\n${quoted}\n\`\`\``)
})

test('injected context keeps its visible text and structured provenance', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: '<environment_context>secret setup</environment_context>' }],
    },
  }), codexTestContext)

  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  const provenance = asRecord(payload.provenance)
  assert.equal(fact.kind, 'context.injected')
  assert.equal(payload.sourceType, 'event_msg')
  assert.equal(payload.injectedContext, true)
  assert.equal(payload.role, 'developer')
  assert.equal(payload.label, 'Developer')
  assert.equal(payload.injectedKind, 'developer')
  assert.equal(payload.text, '<environment_context>secret setup</environment_context>')
  assert.equal(provenance.actualAuthor, 'developer')
  assert.equal(provenance.contentRole, 'developer-context')
  assert.equal(provenance.activityType, 'system-injection')
  assert.equal(provenance.sourceSignal, 'response_item.message.role=developer')
})

test('event_msg agent_reasoning is normalized to canonical message.reasoning', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'event_msg',
    payload: {
      type: 'agent_reasoning',
      text: 'Inspect the runtime chain before changing code.',
      phase: 'analysis',
    },
  }), codexTestContext)

  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  assert.equal(fact.kind, 'message.reasoning')
  assert.equal(payload.text, 'Inspect the runtime chain before changing code.')
  assert.equal(asRecord(payload.raw).phase, 'analysis')
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
  }), codexTestContext)

  const fact = output.observations[0]!
  assert.equal(fact.kind, 'message.reasoning')
  assert.equal(asRecord(fact.payload).text, 'Check parser state.\n\nThen inspect projection.')
})

test('reasoning token statistics are not promoted to Thinking text', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { output_tokens: 20, reasoning_output_tokens: 12 } },
    },
  }), codexTestContext)

  assert.equal(output.observations[0]?.kind, 'usage')
})

test('non-reasoning event_msg keeps original normalization', async () => {
  const output = await normalizeCodexRecord(record({
    type: 'event_msg',
    payload: { type: 'turn_started', turn_id: 'turn-1' },
  }), codexTestContext)

  assert.equal(output.observations[0]?.kind, 'session.lifecycle')
})
