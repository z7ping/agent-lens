import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { CODEX_CURRENT_PARSER_VERSION, normalizeCurrentCodexRecord } from './current-protocol'
import { asRecord, codexTestContext } from './test-support'

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

test('current Codex parser version is 19 so earlier semantic derivations replay', () => {
  assert.equal(CODEX_CURRENT_PARSER_VERSION, '19')
})

test('event_msg.agent_message becomes canonical assistant output instead of background unknown', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'event_msg',
    payload: { type: 'agent_message', message: '这是正常回复', phase: 'final_answer' },
  }, 1), codexTestContext)
  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  const provenance = asRecord(payload.provenance)
  assert.equal(fact.kind, 'message.assistant')
  assert.equal(payload.text, '这是正常回复')
  assert.equal(payload.phase, 'final_answer')
  assert.equal(provenance.actualAuthor, 'assistant')
  assert.equal(provenance.contentRole, 'assistant-output')
  assert.equal(provenance.activityType, 'conversation')
  assert.equal(provenance.sourceSignal, 'event_msg.agent_message')
})

test('legacy raw reasoning is visible Thinking rather than background unknown', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'event_msg',
    payload: { type: 'agent_reasoning_raw_content', text: 'source-visible raw reasoning' },
  }, 2), codexTestContext)
  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  assert.equal(fact.kind, 'message.reasoning')
  assert.equal(payload.text, 'source-visible raw reasoning')
  assert.equal(payload.rawReasoning, true)
  assert.equal(payload.sourceSignal, 'event_msg.agent_reasoning_raw_content')
})

test('legacy response_item assistant remains readable for old Codex rollouts', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: '旧版正常回复' }],
    },
  }, 3), codexTestContext)
  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  assert.equal(fact.kind, 'message.assistant')
  assert.equal(payload.text, '旧版正常回复')
  assert.equal(asRecord(payload.provenance).sourceSignal, 'response_item.message.role=assistant')
})

test('plain response_item role=user stays in SourceRecord/Evidence but does not create a background activity', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'transport echo' }],
    },
  }, 4), codexTestContext)
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
  }, 5), codexTestContext)
  assert.equal(output.observations.length, 1)
  assert.equal(output.observations[0]?.kind, 'context.injected')
  assert.equal(asRecord(output.observations[0]?.payload).injectedKind, 'runtime-environment')
})

test('ResponseItem AgentMessage is agent communication, not user-visible assistant output', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'agent_message', id: 'amsg-1', author: 'worker', recipient: 'root',
      content: [
        { type: 'input_text', text: '子 Agent 已完成检查' },
        { type: 'encrypted_content', encrypted_content: 'opaque-ciphertext' },
      ],
    },
  }, 10), codexTestContext)
  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  assert.equal(fact.kind, 'session.lifecycle')
  assert.equal(payload.event, 'subagent.communication')
  assert.equal(payload.communicationType, 'response.agent_message')
  assert.equal(payload.author, 'worker')
  assert.equal(payload.recipient, 'root')
  assert.equal(payload.text, '子 Agent 已完成检查')
  assert.equal(payload.encryptedContent, true)
  assert.equal(JSON.stringify(fact.payload).includes('opaque-ciphertext'), false)
  assert.equal(output.observations.some(item => item.kind === 'message.assistant'), false)
})

test('ResponseItem LocalShellCall is a tool execution and completed status closes it', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'local_shell_call', id: 'lsh-1', call_id: 'shell-call-1', status: 'completed',
      action: {
        type: 'exec', command: ['cat', 'README.md'], timeout_ms: 1000,
        working_directory: '/safe/project', env: null, user: null,
      },
    },
  }, 11), codexTestContext)
  assert.deepEqual(output.observations.map(item => item.kind), ['tool.call', 'tool.result'])
  const callPayload = asRecord(output.observations[0]?.payload)
  const resultPayload = asRecord(output.observations[1]?.payload)
  assert.equal(callPayload.nativeToolName, 'local_shell')
  assert.equal(callPayload.callId, 'shell-call-1')
  assert.equal(resultPayload.success, true)
  assert.equal(resultPayload.status, 'completed')
})

test('ResponseItem LocalShellCall in progress stays open without a fake result', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'local_shell_call', call_id: 'shell-call-running', status: 'in_progress',
      action: { type: 'exec', command: ['npm', 'test'] },
    },
  }, 12), codexTestContext)
  assert.deepEqual(output.observations.map(item => item.kind), ['tool.call'])
  assert.equal(asRecord(output.observations[0]?.payload).status, 'in_progress')
})

test('ResponseItem ToolSearchCall is a visible tool call rather than raw background activity', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'tool_search_call', id: 'tsc-1', call_id: 'tool-search-1',
      status: 'completed', execution: 'search', arguments: { query: 'read file' },
    },
  }, 13), codexTestContext)
  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  assert.equal(fact.kind, 'tool.call')
  assert.equal(payload.nativeToolName, 'tool_search')
  assert.equal(payload.callId, 'tool-search-1')
  assert.equal(asRecord(payload.input).execution, 'search')
})

test('ResponseItem ImageGenerationCall is an artifact action without duplicating result bytes', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'response_item',
    payload: {
      type: 'image_generation_call', id: 'ig-1', status: 'completed',
      revised_prompt: 'a compact architecture diagram', result: 'x'.repeat(4096),
    },
  }, 14), codexTestContext)
  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  assert.equal(fact.kind, 'artifact.action')
  assert.equal(payload.action, 'image.generate')
  assert.equal(payload.resultAvailable, true)
  assert.equal('result' in payload, false)
})

test('ResponseItem ConfigurationUpdate is lifecycle configuration, not conversation', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'response_item',
    payload: { type: 'configuration_update', reasoning: { effort: 'high' } },
  }, 15), codexTestContext)
  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  assert.equal(fact.kind, 'session.lifecycle')
  assert.equal(payload.event, 'reasoning.configuration.updated')
  assert.equal(asRecord(payload.reasoning).effort, 'high')
})

test('ResponseItem compaction variants are context compaction instead of unknown', async () => {
  for (const [index, payload] of [
    { type: 'compaction', id: 'cmp-1', encrypted_content: 'opaque' },
    { type: 'context_compaction', id: 'ctx-cmp-1', encrypted_content: 'opaque' },
  ].entries()) {
    const output = await normalizeCurrentCodexRecord(record({ type: 'response_item', payload }, 16 + index), codexTestContext)
    const fact = output.observations[0]!
    const factPayload = asRecord(fact.payload)
    assert.equal(fact.kind, 'context.compaction')
    assert.equal(factPayload.opaque, true)
    assert.equal(JSON.stringify(fact.payload).includes('encrypted_content'), false)
  }
})

test('persisted thread goal update is lifecycle metadata rather than raw unknown', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'event_msg',
    payload: {
      type: 'thread_goal_updated', thread_id: 'thread-root', turn_id: 'turn-1',
      goal: { objective: '完成 Parser 收口', status: 'active', token_budget: 1000 },
    },
  }, 20), codexTestContext)
  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  assert.equal(fact.kind, 'session.lifecycle')
  assert.equal(payload.event, 'thread.goal.updated')
  assert.equal(asRecord(payload.goal).objective, '完成 Parser 收口')
})

test('persisted thread rollback is explicit lifecycle metadata', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'event_msg',
    payload: { type: 'thread_rolled_back', num_turns: 2 },
  }, 21), codexTestContext)
  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  assert.equal(fact.kind, 'session.lifecycle')
  assert.equal(payload.event, 'thread.rolled-back')
  assert.equal(payload.num_turns, 2)
})

test('persisted thread settings update carries model/workspace identity without becoming a conversation node', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied', thread_id: 'thread-root',
      thread_settings: { model: 'gpt-5.6-codex', cwd: '/safe/updated-project', reasoning_effort: 'high' },
    },
  }, 22), codexTestContext)
  const fact = output.observations[0]!
  assert.equal(fact.kind, 'session.lifecycle')
  assert.equal(asRecord(fact.payload).event, 'thread.settings.applied')
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
    const output = await normalizeCurrentCodexRecord(record({ type, payload: { marker: type } }, 30 + index), codexTestContext)
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
  }, 40), codexTestContext)
  const fact = output.observations[0]!
  const payload = asRecord(fact.payload)
  assert.equal(fact.kind, 'session.lifecycle')
  assert.equal(payload.event, 'subagent.communication')
  assert.equal(payload.receiver_thread_id, 'thread-child')
})

test('empty assistant/reasoning records preserve evidence but do not create raw background activity', async () => {
  for (const [index, payload] of [
    { type: 'agent_message', message: '' },
    { type: 'agent_reasoning', text: '' },
    { type: 'agent_reasoning_raw_content', text: '' },
  ].entries()) {
    const output = await normalizeCurrentCodexRecord(record({ type: 'event_msg', payload }, 50 + index), codexTestContext)
    assert.equal(output.observations.length, 0)
    assert.equal(output.evidenceCandidates.length, 1)
  }
})
