import assert from 'node:assert/strict'
import test from 'node:test'
import { hermesLiveManifest } from './index'

test('Hermes Live does not advertise Pi thinking-control semantics', () => {
  assert.equal(hermesLiveManifest.capabilities.includes('thinking-control'), false)
})
