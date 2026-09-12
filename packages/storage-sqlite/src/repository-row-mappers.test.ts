import assert from 'node:assert/strict'
import test from 'node:test'
import { mapObservation } from './repository-row-mappers.js'

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
