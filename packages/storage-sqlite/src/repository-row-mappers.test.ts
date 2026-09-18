import assert from 'node:assert/strict'
import test from 'node:test'
import { mapAssetBinding, mapObservation } from './repository-row-mappers.js'

test('mapObservation accepts persisted runtime startup observations', () => {
  const observation = mapObservation({
    id: 'obs-runtime-startup',
    host_id: 'host-1',
    installation_id: 'installation-1',
    logical_session_id: 'session-1',
    source_session_id: 'source-session-1',
    kind: 'runtime.startup',
    captured_at: '2026-09-12T00:00:00.000Z',
    payload_json: '{"event":"runtime.startup.audit"}',
  })

  assert.equal(observation.kind, 'runtime.startup')
})


test('mapAssetBinding preserves structured package identity for replication roots', () => {
  const binding = mapAssetBinding({
    id: 'binding-package',
    asset_id: 'asset-package',
    installation_id: 'installation-pi',
    source: 'opaque-source',
    package_identity: 'npm:@example/pi-tools',
    version: '2.1.0',
  })

  assert.equal(binding.source, 'opaque-source')
  assert.equal(binding.packageIdentity, 'npm:@example/pi-tools')
  assert.equal(binding.version, '2.1.0')
})
