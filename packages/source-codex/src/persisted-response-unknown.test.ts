import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { normalizeCurrentCodexRecord } from './current-protocol'

const ctx = {
  host: { id: 'host', name: 'host', platform: 'linux', arch: 'x64', createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
  installation: { id: 'install', hostId: 'host', productId: 'codex', firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z' },
} as any

function record(payload: Record<string, unknown>, sourceSequence: number): SourceRecord {
  return {
    id: `persisted-response-${sourceSequence}`,
    sourceId: 'codex',
    installationId: 'install',
    sourceSessionNativeId: 'thread-root',
    nativeType: 'rollout',
    sourceSequence,
    occurredAt: '2026-09-05T09:00:00.000Z',
    capturedAt: '2026-09-05T09:00:01.000Z',
    locator: { kind: 'file', path: '/safe/rollout.jsonl', offset: sourceSequence },
    payload: {
      entry: { type: 'response_item', payload },
      session: { nativeSessionId: 'thread-root', cwd: '/safe/project' },
    },
    parserVersion: '18',
  }
}

test('official persisted ResponseItem variants do not degrade to unknown', async () => {
  const payloads: Record<string, unknown>[] = [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    { type: 'agent_message', id: 'agent-message-1', author: 'worker', recipient: 'root', content: [{ type: 'input_text', text: 'done' }] },
    { type: 'reasoning', id: 'reasoning-1', summary: [{ type: 'summary_text', text: 'thinking' }], encrypted_content: null },
    { type: 'local_shell_call', id: 'shell-1', call_id: 'shell-call-1', status: 'completed', action: { type: 'exec', command: ['pwd'] } },
    { type: 'function_call', name: 'read_file', call_id: 'function-call-1', arguments: '{}' },
    { type: 'tool_search_call', id: 'tool-search-1', call_id: 'tool-search-call-1', status: 'completed', execution: 'search', arguments: { query: 'read file' } },
    { type: 'function_call_output', call_id: 'function-call-1', output: 'ok' },
    { type: 'tool_search_output', call_id: 'tool-search-call-1', status: 'completed', execution: 'search', tools: [] },
    { type: 'custom_tool_call', name: 'custom', call_id: 'custom-call-1', input: '{}' },
    { type: 'custom_tool_call_output', call_id: 'custom-call-1', output: 'ok' },
    { type: 'web_search_call', id: 'web-search-1', status: 'completed', action: { type: 'search', query: 'AgentLens' } },
    { type: 'image_generation_call', id: 'image-1', status: 'completed', revised_prompt: 'diagram', result: 'image-bytes' },
    { type: 'configuration_update', reasoning: { effort: 'high' } },
    { type: 'compaction', id: 'compaction-1', encrypted_content: 'opaque' },
    { type: 'context_compaction', id: 'context-compaction-1', encrypted_content: 'opaque' },
  ]

  for (const [index, payload] of payloads.entries()) {
    const output = await normalizeCurrentCodexRecord(record(payload, index + 1), ctx)
    assert.equal(output.observations.some(item => item.kind === 'unknown'), false, String(payload.type))
  }
})

test('encrypted-only persisted reasoning keeps evidence without manufacturing a Review activity', async () => {
  const output = await normalizeCurrentCodexRecord(record({
    type: 'reasoning',
    id: 'reasoning-encrypted-only',
    summary: [],
    encrypted_content: 'opaque-ciphertext',
  }, 20), ctx)

  assert.equal(output.observations.length, 0)
  assert.equal(output.evidenceCandidates.length, 1)
})
