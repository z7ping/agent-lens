import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { normalizePiRecord } from './index'

function record(entry: Record<string, unknown>, nativeId?: string): SourceRecord {
  return {
    id: 'pi-record-native-identity',
    sourceId: 'pi',
    installationId: 'installation-pi',
    sourceSessionNativeId: 'pi-session-native-identity',
    nativeType: `history/${String(entry.type ?? 'unknown')}`,
    ...(nativeId ? { nativeId } : {}),
    sourceSequence: 1000,
    capturedAt: '2026-09-11T00:00:00.000Z',
    locator: { kind: 'file', path: '/tmp/pi/session.jsonl', offset: 10 },
    fingerprint: 'pi-native-identity-fingerprint',
    parserVersion: '8',
    payload: {
      entry,
      session: {
        nativeSessionId: 'pi-session-native-identity',
        cwd: '/workspace/pi',
      },
    },
  }
}

test('Pi derived assistant facts use internal shared keys instead of fabricated nativeEventId', async () => {
  const normalized = await normalizePiRecord(record({
    type: 'message',
    id: 'assistant-native-id',
    parentId: 'user-native-id',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      usage: { input: 10, output: 5, totalTokens: 15 },
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    },
  }, 'assistant-native-id'), {} as never)

  assert.equal(normalized.observations.length, 4)

  const first = normalized.observations[0]!
  assert.equal(first.kind, 'message.assistant')
  assert.equal(first.nativeEventId, 'assistant-native-id')
  assert.equal(first.nativeParentEventId, 'user-native-id')
  assert.equal(first.dedupHints?.nativeEventId, 'assistant-native-id')

  const second = normalized.observations[1]!
  assert.equal(second.kind, 'message.assistant')
  assert.equal(second.nativeEventId, undefined)
  assert.equal(second.nativeParentEventId, 'assistant-native-id')
  assert.equal(second.dedupHints?.nativeEventId, undefined)
  assert.equal(second.dedupHints?.sharedEventKey, 'assistant-native-id:content:1')

  const stop = normalized.observations[2]!
  assert.equal(stop.nativeEventId, undefined)
  assert.equal(stop.nativeParentEventId, 'assistant-native-id')
  assert.equal(stop.dedupHints?.sharedEventKey, 'assistant-native-id:stop')

  const usage = normalized.observations[3]!
  assert.equal(usage.nativeEventId, undefined)
  assert.equal(usage.nativeParentEventId, 'assistant-native-id')
  assert.equal(usage.dedupHints?.sharedEventKey, 'assistant-native-id:usage')
})

test('Pi record without upstream entry id never promotes fallback ids into native identity', async () => {
  const normalized = await normalizePiRecord(record({
    type: 'future_entry',
    payload: { value: 1 },
  }), {} as never)

  assert.equal(normalized.observations.length, 1)
  const unknown = normalized.observations[0]!
  assert.equal(unknown.kind, 'unknown')
  assert.equal(unknown.nativeEventId, undefined)
  assert.equal(unknown.dedupHints?.nativeEventId, undefined)
  assert.equal(unknown.dedupHints?.sharedEventKey, 'pi-record-native-identity')
  assert.equal(normalized.evidenceCandidates[0]?.nativeStableId, undefined)
})

test('Pi evidence nativeStableId comes from raw upstream entry id, not legacy SourceRecord nativeId', async () => {
  const normalized = await normalizePiRecord(record({
    type: 'session',
    id: 'real-session-id',
    cwd: '/workspace/pi',
  }, 'session:real-session-id'), {} as never)

  assert.equal(normalized.observations[0]?.nativeEventId, 'real-session-id')
  assert.equal(normalized.evidenceCandidates[0]?.nativeStableId, 'real-session-id')
})

test('Pi normalizer leaves generic text bounding to central CapturePolicy', async () => {
  const text = 'x'.repeat(70_000)
  const normalized = await normalizePiRecord(record({
    type: 'message',
    id: 'long-user-message',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  }, 'long-user-message'), {} as never)

  assert.equal((normalized.observations[0]?.payload as { text?: string }).text?.length, text.length)
})

