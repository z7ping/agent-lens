import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDataRuntimeWorkerUrl } from './client'

test('source Data Runtime resolves through explicit mjs bootstrap', () => {
  const source = resolveDataRuntimeWorkerUrl('file:///repo/apps/daemon/src/data-runtime/client.ts')
  const bundled = resolveDataRuntimeWorkerUrl('file:///repo/dist/daemon.mjs')
  assert.equal(source.pathname.endsWith('/worker-source.mjs'), true)
  assert.equal(bundled.pathname.endsWith('/data-runtime-worker.mjs'), true)
})
