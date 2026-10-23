import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePiCacheOptimizerStatus } from './cache-status'

const status = (statusText: string | undefined, statusKey = 'pi-cache-stats') => ({
  type: 'extension_ui_request', method: 'setStatus', statusKey, statusText,
})

test('reads only pi-cache-optimizer native footer facts and flags real compat warnings', () => {
  assert.deepEqual(parsePiCacheOptimizerStatus(status('· DS cache 3/10·0.002M/0.005M 40.0% ⚠️ compat')), {
    source: 'pi-cache-optimizer', adapter: 'DS', hitRequests: 3, totalRequests: 10,
    cachedInput: '0.002M', totalInput: '0.005M',
    tokenHitRate: 40, compatibility: 'warning',
  })
  assert.deepEqual(parsePiCacheOptimizerStatus(status('· OpenAI cache 0/0·0M/0M 0.0%')), {
    source: 'pi-cache-optimizer', adapter: 'OpenAI', hitRequests: 0, totalRequests: 0,
    cachedInput: '0M', totalInput: '0M', tokenHitRate: 0, compatibility: 'ok',
  })
  const disabled = parsePiCacheOptimizerStatus(status('· Cache Optimizer disabled · Qwen cache 1/2·0.2M/0.4M 50.0%'))
  assert.equal(disabled?.compatibility, 'disabled')
  const integrity = parsePiCacheOptimizerStatus(status('· Kimi cache 1/2·0.2M/0.4M 50.0% ⚠️ integrity'))
  assert.equal(integrity?.integrityWarning, true)
})

test('does not mistake unrelated statuses, model mode or malformed numbers for cache facts', () => {
  assert.equal(parsePiCacheOptimizerStatus(status('· DS cache 3/10·0M/0M 40.0%', 'different-extension')), undefined)
  assert.equal(parsePiCacheOptimizerStatus({ type: 'runtime_status', status: 'compatibility' }), undefined)
  assert.equal(parsePiCacheOptimizerStatus(status(undefined)), null)
  assert.equal(parsePiCacheOptimizerStatus(status('· DS cache 10/3·0M/0M 40.0%')), null)
  assert.equal(parsePiCacheOptimizerStatus(status('· DS cache 2/3·0M/0M 120.0%')), null)
  assert.equal(parsePiCacheOptimizerStatus(status('untrusted prompt')), null)
})
