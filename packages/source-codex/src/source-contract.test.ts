import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceExecutionContext, SourceRecord } from '@agent-lens/core'
import {
  CODEX_CURRENT_PARSER_VERSION,
  codexRuntimeInternals,
  declareCodexCapabilities,
  normalizeCurrentCodexRecord,
} from './index'

function historyRecord(entry: Record<string, unknown>, nativeId?: string): SourceRecord {
  return {
    id: 'codex-record-contract',
    sourceId: 'codex',
    installationId: 'installation-codex',
    sourceSessionNativeId: 'session-codex',
    nativeType: `response_item/${String((entry.payload as { type?: unknown } | undefined)?.type ?? 'unknown')}`,
    ...(nativeId ? { nativeId } : {}),
    sourceSequence: 100,
    capturedAt: '2026-09-11T00:00:00.000Z',
    locator: { kind: 'file', path: '/tmp/rollout.jsonl', offset: 10 },
    fingerprint: 'codex-fingerprint',
    parserVersion: CODEX_CURRENT_PARSER_VERSION,
    payload: {
      entry,
      session: { nativeSessionId: 'session-codex', cwd: '/workspace' },
    },
  }
}

test('Codex missing function call id stays internal instead of becoming nativeCallId', async () => {
  const normalized = await normalizeCurrentCodexRecord(historyRecord({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'exec',
      arguments: '{"cmd":"pwd"}',
    },
  }), {} as never)

  const call = normalized.observations.find(item => item.kind === 'tool.call')
  assert.ok(call)
  assert.equal(call.nativeCallId, undefined)
  assert.equal(call.nativeEventId, undefined)
  assert.equal(call.dedupHints?.nativeCallId, undefined)
  assert.equal(call.dedupHints?.sharedEventKey, 'codex-call:codex-record-contract')
})

test('Codex local shell without native call id correlates internally without fabricating one', async () => {
  const normalized = await normalizeCurrentCodexRecord(historyRecord({
    type: 'response_item',
    payload: {
      type: 'local_shell_call',
      status: 'completed',
      action: { command: 'pwd' },
    },
  }), {} as never)

  const call = normalized.observations.find(item => item.kind === 'tool.call')
  const result = normalized.observations.find(item => item.kind === 'tool.result')
  assert.ok(call)
  assert.ok(result)
  assert.equal(call.nativeCallId, undefined)
  assert.equal(result.nativeCallId, undefined)
  assert.equal(call.dedupHints?.sharedEventKey, 'codex-call:codex-record-contract')
  assert.equal(result.dedupHints?.sharedEventKey, 'codex-call:codex-record-contract')
})

test('Codex runtime call id does not double as SourceRecord native event id', () => {
  const envelope = codexRuntimeInternals.parseEnvelope(JSON.stringify({
    id: 'agent-lens-envelope-id',
    capturedAt: '2026-09-11T00:00:00.000Z',
    event: {
      hook_event_name: 'PreToolUse',
      session_id: 'session-codex',
      call_id: 'native-call-1',
      tool_name: 'exec',
    },
  }), 'runtime.json')

  const record = codexRuntimeInternals.sourceRecordFromEnvelope(envelope, '/tmp/runtime.json', {
    installation: {
      id: 'installation-codex',
      hostId: 'host',
      productId: 'codex',
      firstSeenAt: '2026-09-11T00:00:00.000Z',
      lastSeenAt: '2026-09-11T00:00:00.000Z',
    },
    abortSignal: new AbortController().signal,
  } as SourceExecutionContext)

  assert.equal(record.nativeId, undefined)
  assert.equal((record.payload as { runtimeEvent?: { call_id?: string } }).runtimeEvent?.call_id, 'native-call-1')
})

test('Codex asset discovery is explicitly partial after static-state tightening', async () => {
  const capabilities = await declareCodexCapabilities({} as never)
  assert.equal(capabilities.find(item => item.name === 'asset-discovery')?.status, 'partial')
})
