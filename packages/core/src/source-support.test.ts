import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from './domain/observation'
import { evidenceFromSourceRecord, observationFromSourceRecord } from './source-support'

const record: SourceRecord = {
  id: 'record-1',
  sourceId: 'test',
  installationId: 'installation-1',
  nativeType: 'message',
  sourceSequence: 1000,
  occurredAt: '2026-09-11T00:00:00.000Z',
  capturedAt: '2026-09-11T00:00:01.000Z',
  locator: { kind: 'file', path: '/tmp/source.jsonl', offset: 10 },
  fingerprint: 'fingerprint-1',
  payload: { raw: true },
  parserVersion: '1',
}

test('source observation helper only writes native identity when the adapter supplies it', () => {
  const value = observationFromSourceRecord(record, {
    kind: 'message.assistant',
    payload: { text: 'hello' },
    identityHints: { nativeSessionId: 'session-1' },
    sharedEventKey: 'internal-fact-1',
    sequenceOffset: 2,
  })

  assert.equal(value.nativeEventId, undefined)
  assert.equal(value.nativeCallId, undefined)
  assert.equal(value.dedupHints?.nativeEventId, undefined)
  assert.equal(value.dedupHints?.nativeCallId, undefined)
  assert.equal(value.dedupHints?.sharedEventKey, 'internal-fact-1')
  assert.equal(value.sourceSequence, 1002)
  assert.equal(value.dedupHints?.sourceSequence, 1002)
  assert.equal(value.dedupHints?.payloadFingerprint, 'fingerprint-1')
})

test('source evidence helper keeps record mechanics central while native identity stays explicit', () => {
  const withoutNative = evidenceFromSourceRecord(record, {
    captureMethod: 'native-log',
    derivation: 'reported',
    confidenceHint: 'high',
  })
  assert.equal(withoutNative.nativeStableId, undefined)
  assert.equal(withoutNative.sourceRecordId, record.id)
  assert.deepEqual(withoutNative.sourceLocator, record.locator)

  const withNative = evidenceFromSourceRecord(record, {
    captureMethod: 'native-log',
    derivation: 'reported',
    nativeStableId: 'native-1',
    confidenceHint: 'exact',
  })
  assert.equal(withNative.nativeStableId, 'native-1')
})
