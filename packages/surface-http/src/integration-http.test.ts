import assert from 'node:assert/strict'
import test from 'node:test'
import { integrationAuthorizationHttpInternals } from './integration-http'

test('Integration authorization decoder rejects malformed URL encoding as a bad request', () => {
  assert.throws(
    () => integrationAuthorizationHttpInternals.decodeProductId('%E0%A4%A'),
    error => error instanceof Error
      && error.name === 'HttpError'
      && error.message === 'productId is not valid URL encoding',
  )
})
