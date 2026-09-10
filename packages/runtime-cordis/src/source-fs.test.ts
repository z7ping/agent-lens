import assert from 'node:assert/strict'
import test from 'node:test'
import { isMissingPathError } from './source-fs'

test('source fs helper distinguishes absence from permission/io failures', () => {
  assert.equal(isMissingPathError({ code: 'ENOENT' }), true)
  assert.equal(isMissingPathError({ code: 'ENOTDIR' }), true)
  assert.equal(isMissingPathError({ code: 'EACCES' }), false)
  assert.equal(isMissingPathError({ code: 'EPERM' }), false)
  assert.equal(isMissingPathError(new Error('boom')), false)
})
