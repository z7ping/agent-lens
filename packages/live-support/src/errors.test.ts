import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeNativeLiveError } from './errors'

test('native error parser retains nested diagnostics without inferring retry policy', () => {
  assert.deepEqual(normalizeNativeLiveError({
    code: 'E42', cause: { message: 'transport closed', category: 'network', retryable: false },
  }, 'fallback'), {
    type: 'error', message: 'transport closed', code: 'E42',
    category: 'network', retryable: false,
  })
  assert.deepEqual(normalizeNativeLiveError({ code: 'UNKNOWN', category: 'untrusted' }, 'fallback'), {
    type: 'error', message: 'UNKNOWN', code: 'UNKNOWN',
  })
})

test('native error parser remains bounded for recursive aggregates', () => {
  const native: { code: string; cause?: unknown } = { code: 'CYCLE' }
  native.cause = native
  assert.deepEqual(normalizeNativeLiveError(native, 'fallback'), {
    type: 'error', message: 'CYCLE', code: 'CYCLE',
  })
})
