import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { CODEX_CURRENT_PARSER_VERSION, normalizeCurrentCodexRecord } from './current-protocol'

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
    parserVersion: CODEX_CURRENT_PARSER_VERSION,
  }
}

test('current Codex parser version is 17 so earlier semantic derivations replay', () => {
  assert.equal(CODEX_CURRENT_PARSER_VERSION, '17')
})

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

test('plain response_item role=user stays in SourceRecord/Evidence but does not create a background activity', async () => {
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

test('response_item role=user runtime context remains a structured context activity', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/safe/project</cwd>\n</environment_context>' }],
    },
  }, 5), ctx)

  assert.equal(output.observations.length, 1)
  assert.equal(output.observations[0]?.kind, 'context.injected')
  assert.equal((output.observations[0]?.payload as any).injectedKind, 'runtime-environment')
})

test('persisted thread goal update is lifecycle metadata rather than raw unknown', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'event_msg',
    payload: {
      type: 'thread_goal_updated', thread_id: 'thread-root', turn_id: 'turn-1',
      goal: { objective: '完成 Parser 收口', status: 'active', token_budget: 1000 },
    },
  }, 6), ctx)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'session.lifecycle')
  assert.equal((fact.payload as any).event, 'thread.goal.updated')
  assert.equal((fact.payload as any).goal.objective, '完成 Parser 收口')
})

test('persisted thread rollback is explicit lifecycle metadata', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'event_msg',
    payload: { type: 'thread_rolled_back', num_turns: 2 },
  }, 7), ctx)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'session.lifecycle')
  assert.equal((fact.payload as any).event, 'thread.rolled-back')
  assert.equal((fact.payload as any).num_turns, 2)
})

test('persisted thread settings update carries model/workspace identity without becoming a conversation node', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied', thread_id: 'thread-root',
      thread_settings: { model: 'gpt-5.6-codex', cwd: '/safe/updated-project', reasoning_effort: 'high' },
    },
  }, 8), ctx)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'session.lifecycle')
  assert.equal((fact.payload as any).event, 'thread.settings.applied')
  assert.equal(fact.identityHints.modelName, 'gpt-5.6-codex')
  assert.equal(fact.identityHints.workspacePath, '/safe/updated-project')
})

test('persisted rollout snapshots stay in SourceRecord/Evidence without manufacturing Review activity', async () => {
  const types = [
    'world_state',
    'retained_context',
    'security_risk_score',
    'realtime_item',
    'inter_agent_communication_metadata',
  ]
  for (const [index, type] of types.entries()) {
    const output = await normalizeCurrentCodexRecord(record({ type, payload: { marker: type } }, 20 + index), ctx)
    assert.equal(output.observations.length, 0, type)
    assert.equal(output.evidenceCandidates.length, 1, type)
  }
})

test('inter-agent communication remains an explicit subagent activity', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'inter_agent_communication',
    payload: {
      sender_thread_id: 'thread-root', receiver_thread_id: 'thread-child',
      message: '检查这一段实现',
    },
  }, 30), ctx)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'session.lifecycle')
  assert.equal((fact.payload as any).event, 'subagent.communication')
  assert.equal((fact.payload as any).receiver_thread_id, 'thread-child')
})

test('empty assistant/reasoning records preserve evidence but do not create raw background activity', async () => {
  for (const [index, payload] of [
    { type: 'agent_message', message: '' },
    { type: 'agent_reasoning', text: '' },
    { type: 'agent_reasoning_raw_content', text: '' },
  ].entries()) {
    const output = await normalizeCurrentCodexRecord(record({ type: 'event_msg', payload }, 40 + index), ctx)
    assert.equal(output.observations.length, 0)
    assert.equal(output.evidenceCandidates.length, 1)
  }
})