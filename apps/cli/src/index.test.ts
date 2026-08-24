import assert from 'node:assert/strict'
import test from 'node:test'
import { cliInternals } from './index'

test('CLI node version comparison honors the 22.23 floor', () => {
  assert.deepEqual(cliInternals.parseNodeVersion('v22.23.1'), [22, 23, 1])
  assert.equal(cliInternals.versionAtLeast([22, 23, 0], [22, 23, 0]), true)
  assert.equal(cliInternals.versionAtLeast([23, 0, 0], [22, 23, 0]), true)
  assert.equal(cliInternals.versionAtLeast([22, 22, 9], [22, 23, 0]), false)
})

test('CLI hook target parser keeps all as the default', () => {
  assert.equal(cliInternals.targetFrom(undefined), 'all')
  assert.equal(cliInternals.targetFrom('all'), 'all')
  assert.equal(cliInternals.targetFrom('codex'), 'codex')
  assert.equal(cliInternals.targetFrom('claude'), 'claude')
  assert.throws(() => cliInternals.targetFrom('pi'), /Unknown hook target/)
})

test('CLI runtime owner parser tolerates old health payloads', () => {
  assert.equal(cliInternals.runtimeOwner({ protocolVersion: '1.0' }), null)
  assert.equal(cliInternals.runtimeOwner({ runtime: { owner: 'desktop' } }), 'desktop')
  assert.equal(cliInternals.runtimeOwner({ runtime: { owner: 'service' } }), 'service')
  assert.equal(cliInternals.runtimeOwner({ runtime: null }), null)
})
