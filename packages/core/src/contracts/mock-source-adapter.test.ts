import test from 'node:test'
import assert from 'node:assert/strict'
import type { SourceDefinition } from './source'
import type { SourceRecord } from '../domain/observation'

function mockSource(): SourceDefinition {
  return {
    manifest: {
      pluginId: 'agent-lens-test-mock-source',
      pluginVersion: '1.0.0',
      apiVersion: '1.0',
      pluginType: 'source',
      displayName: 'Mock Source',
      sourceId: 'mock-source',
      productId: 'mock',
      parserVersion: '1',
    },
    async detect() { return [] },
    async declareCapabilities() {
      return [{ sourceId: 'mock-source', name: 'history', status: 'available', captureModes: ['native-log'] }]
    },
    async normalize(record) {
      return {
        observations: [{
          kind: 'unknown',
          capturedAt: record.capturedAt,
          nativeEventId: record.nativeId,
          identityHints: { nativeSessionId: record.sourceSessionNativeId ?? 'unknown' },
          payload: { rawType: record.nativeType, rawPayload: record.payload },
        }],
        evidenceCandidates: [{
          captureMethod: 'native-log',
          derivation: 'observed',
          confidenceHint: 'exact',
          sourceRecordId: record.id,
          sourceLocator: record.locator,
          capturedAt: record.capturedAt,
        }],
      }
    },
  }
}

test('third-party Source mock retains unknown native records and evidence for Canonical', async () => {
  const source = mockSource()
  assert.equal(source.manifest.pluginType, 'source')
  const record: SourceRecord = {
    id: 'record-1',
    sourceId: 'mock-source',
    installationId: 'mock-installation',
    nativeType: 'mock.custom',
    nativeId: 'event-1',
    sourceSessionNativeId: 'mock-session',
    capturedAt: '2026-10-20T00:00:00.000Z',
    locator: { kind: 'file', path: '/example/test.log' },
    payload: { value: 42 },
    parserVersion: '1',
  }
  const output = await source.normalize(record, {} as Parameters<SourceDefinition['normalize']>[1])
  assert.equal(output.observations[0]?.kind, 'unknown')
  assert.deepEqual(output.observations[0]?.payload, { rawType: 'mock.custom', rawPayload: { value: 42 } })
  assert.equal(output.observations[0]?.identityHints.nativeSessionId, 'mock-session')
  assert.equal(output.evidenceCandidates[0]?.sourceRecordId, 'record-1')
})
