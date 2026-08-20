import assert from 'node:assert/strict'
import test from 'node:test'
import { cliInternals } from './index'

test('CLI node version comparison honors the 22.12 floor', () => {
  assert.deepEqual(cliInternals.parseNodeVersion('v22.12.1'), [22, 12, 1])
  assert.equal(cliInternals.versionAtLeast([22, 12, 0], [22, 12, 0]), true)
  assert.equal(cliInternals.versionAtLeast([23, 0, 0], [22, 12, 0]), true)
  assert.equal(cliInternals.versionAtLeast([22, 11, 9], [22, 12, 0]), false)
})

test('CLI hook target parser keeps all as the default', () => {
  assert.equal(cliInternals.targetFrom(undefined), 'all')
  assert.equal(cliInternals.targetFrom('all'), 'all')
  assert.equal(cliInternals.targetFrom('codex'), 'codex')
  assert.equal(cliInternals.targetFrom('claude'), 'claude')
  assert.throws(() => cliInternals.targetFrom('pi'), /Unknown hook target/)
})
