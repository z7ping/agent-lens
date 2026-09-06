import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { normalizeCurrentCodexRecord } from './current-protocol'
import { codexTestContext } from './test-support'

function record(entry: Record<string, unknown>, sequence: number): SourceRecord {
  return {
    id: `official-persisted-${sequence}`,
    sourceId: 'codex',
    installationId: 'install',
    sourceSessionNativeId: 'thread-root',
    nativeType: 'rollout',
    sourceSequence: sequence,
    occurredAt: '2026-09-06T00:00:00.000Z',
    capturedAt: '2026-09-06T00:00:01.000Z',
    locator: { kind: 'file', path: '/safe/rollout.jsonl', offset: sequence },
    payload: { entry, session: { nativeSessionId: 'thread-root', cwd: '/safe/project' } },
    parserVersion: '19',
  }
}

function completed(item: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'thread-root',
      turn_id: 'turn-1',
      item,
      started_at_ms: 0,
      completed_at_ms: 1,
    },
  }
}

async function assertCanonical(entry: Record<string, unknown>, sequence: number, expectedKinds: string[]): Promise<void> {
  const output = await normalizeCurrentCodexRecord(record(entry, sequence), codexTestContext)
  assert.equal(output.observations.some(item => item.kind === 'unknown'), false)
  assert.deepEqual(output.observations.map(item => item.kind), expectedKinds)
}

test('official persisted Paginated tool/search/compaction TurnItems stay canonical', async () => {
  await assertCanonical(completed({
    type: 'DynamicToolCall',
    id: 'dynamic-1',
    namespace: 'workspace',
    tool: 'lookup',
    arguments: { query: 'AgentLens' },
    status: 'completed',
    content_items: [{ type: 'text', text: 'found' }],
    success: true,
  }), 1, ['tool.call', 'tool.result'])

  await assertCanonical(completed({
    type: 'McpToolCall',
    id: 'mcp-1',
    server: 'docs',
    tool: 'read',
    arguments: { path: '/safe/doc' },
    status: 'completed',
    result: { content: [], isError: false },
  }), 2, ['tool.call', 'tool.result'])

  await assertCanonical(completed({
    type: 'WebSearch',
    id: 'web-1',
    query: 'AgentLens',
    action: { type: 'search', query: 'AgentLens' },
    results: [],
  }), 3, ['tool.call', 'tool.result'])

  await assertCanonical(completed({
    type: 'ContextCompaction',
    id: 'compact-1',
  }), 4, ['context.compaction'])
})

test('all current official ExtensionItem kinds stay canonical', async () => {
  await assertCanonical(completed({
    type: 'Extension',
    kind: 'clock.sleep',
    id: 'sleep-1',
    durationMs: 250,
  }), 10, ['tool.call'])

  await assertCanonical(completed({
    type: 'Extension',
    kind: 'web.search',
    id: 'extension-web-1',
    query: 'AgentLens',
    action: { type: 'search', query: 'AgentLens' },
    results: [],
  }), 11, ['tool.call', 'tool.result'])

  await assertCanonical(completed({
    type: 'Extension',
    kind: 'image_gen.generation',
    id: 'extension-image-1',
    status: 'completed',
    revisedPrompt: 'architecture diagram',
    result: 'image-bytes',
    savedPath: '/safe/generated.png',
  }), 12, ['artifact.action'])
})

test('official persisted legacy context compaction does not fall back to unknown', async () => {
  await assertCanonical({
    type: 'event_msg',
    payload: { type: 'context_compacted', turn_id: 'turn-1' },
  }, 20, ['context.compaction'])
})
