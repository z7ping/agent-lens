import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceExecutionContext, SourceRecord } from '@agent-lens/core'
import {
  declareOpenCodeCapabilities,
  normalizeOpenCodeRecord,
  openCodeSourceInternals,
} from './index'

function record(part: Record<string, unknown>, message: Record<string, unknown>, nativeId?: string): SourceRecord {
  return {
    id: 'opencode-record-contract',
    sourceId: 'opencode',
    installationId: 'installation-opencode',
    sourceSessionNativeId: 'session-opencode',
    nativeType: `part/${String(part.type ?? 'unknown')}`,
    ...(nativeId ? { nativeId } : {}),
    sourceSequence: 100,
    capturedAt: '2026-09-11T00:00:00.000Z',
    locator: { kind: 'database', path: '/tmp/opencode.db', table: 'part', rowId: '1' },
    fingerprint: 'opencode-fingerprint',
    parserVersion: '3',
    payload: {
      part,
      message,
      session: { nativeSessionId: 'session-opencode' },
      captureChannel: 'history',
    },
  }
}

test('OpenCode tool part id never substitutes for missing native call id', async () => {
  const normalized = await normalizeOpenCodeRecord(record({
    type: 'tool',
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command: 'pwd' },
      output: '/tmp',
    },
  }, { role: 'assistant' }, 'part-native-id'), {} as never)

  assert.equal(normalized.observations.length, 2)
  const call = normalized.observations[0]!
  const result = normalized.observations[1]!
  assert.equal(call.kind, 'tool.call')
  assert.equal(result.kind, 'tool.result')
  assert.equal(call.nativeCallId, undefined)
  assert.equal(result.nativeCallId, undefined)
  assert.equal(call.nativeEventId, 'part-native-id')
  assert.equal(result.nativeEventId, 'part-native-id')
  assert.equal(call.dedupHints?.sharedEventKey, 'opencode-tool:opencode-record-contract')
  assert.equal(result.dedupHints?.sharedEventKey, 'opencode-tool:opencode-record-contract')
})

test('OpenCode missing Part id stays out of SourceRecord nativeId', () => {
  const value = openCodeSourceInternals.recordFromRow({
    row_id: 42,
    id: null,
    message_id: 'message-1',
    session_id: 'session-1',
    time_created: 1_787_000_000_000,
    data: JSON.stringify({ type: 'text', text: 'hello' }),
    message_data: JSON.stringify({ role: 'user' }),
    directory: '/workspace',
    session_title: 'title',
  }, {
    installation: {
      id: 'installation-opencode',
      hostId: 'host',
      productId: 'opencode',
      dataRoot: '/tmp',
      firstSeenAt: '2026-09-11T00:00:00.000Z',
      lastSeenAt: '2026-09-11T00:00:00.000Z',
    },
    abortSignal: new AbortController().signal,
  } as SourceExecutionContext, 'history')

  assert.equal(value.nativeId, undefined)
  assert.equal(value.locator.kind, 'database')
  assert.equal(value.locator.kind === 'database' ? value.locator.rowId : undefined, '42')
})

test('OpenCode normalizer leaves generic text bounding to central CapturePolicy', async () => {
  const text = 'x'.repeat(70_000)
  const normalized = await normalizeOpenCodeRecord(record(
    { type: 'text', text },
    { role: 'user' },
    'part-text-id',
  ), {} as never)

  assert.equal((normalized.observations[0]?.payload as { text?: string }).text?.length, text.length)
})

test('OpenCode asset discovery remains unavailable until native inventory semantics are proven', async () => {
  const capabilities = await declareOpenCodeCapabilities({} as never)
  const assets = capabilities.find(item => item.name === 'asset-discovery')
  assert.equal(assets?.status, 'unavailable')
})

test('OpenCode parser replay neutralizes legacy row fallback nativeId', async () => {
  const legacy: SourceRecord = {
    ...record(
      { type: 'text', text: 'legacy' },
      { role: 'user' },
      'row-42',
    ),
    locator: { kind: 'database', path: '/tmp/opencode.db', table: 'part', rowId: '42' },
  }

  const normalized = await normalizeOpenCodeRecord(legacy, {} as never)
  assert.equal(normalized.observations[0]?.nativeEventId, undefined)
  assert.equal(normalized.evidenceCandidates[0]?.nativeStableId, undefined)
})

test('OpenCode sessionless row stays evidence-only instead of creating an unknown native session', async () => {
  const value = openCodeSourceInternals.recordFromRow({
    row_id: 99,
    id: 'part-99',
    message_id: 'message-99',
    session_id: null,
    time_created: 1_787_000_000_000,
    data: JSON.stringify({ type: 'text', text: 'orphan' }),
    message_data: JSON.stringify({ role: 'user' }),
    directory: null,
    session_title: null,
  }, {
    installation: {
      id: 'installation-opencode',
      hostId: 'host',
      productId: 'opencode',
      dataRoot: '/tmp',
      firstSeenAt: '2026-09-11T00:00:00.000Z',
      lastSeenAt: '2026-09-11T00:00:00.000Z',
    },
    abortSignal: new AbortController().signal,
  } as SourceExecutionContext, 'history')

  assert.equal(value.sourceSessionNativeId, undefined)
  const normalized = await normalizeOpenCodeRecord(value, {} as never)
  assert.deepEqual(normalized.observations, [])
  assert.equal(normalized.evidenceCandidates.length, 1)
})
