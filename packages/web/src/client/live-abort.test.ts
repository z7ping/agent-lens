import assert from 'node:assert/strict'
import test from 'node:test'
import { liveApi } from './live'

test('Live abortable history index bypasses shared GET pool and aborts fetch', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let aborted = false
  globalThis.fetch = ((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      aborted = true
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })) as typeof fetch

  const controller = new AbortController()
  const pending = liveApi.historyIndex('pi', 'runtime-1', { cursor: 'round-1', limit: 1 }, controller.signal)
  controller.abort()
  await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError')
  assert.equal(aborted, true)
})

test('Live abortable snapshot aborts the underlying fetch', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let aborted = false
  globalThis.fetch = ((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      aborted = true
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })) as typeof fetch

  const controller = new AbortController()
  const pending = liveApi.snapshot('pi', 'runtime-1', undefined, { after: 'round-1', limit: 20 }, controller.signal)
  controller.abort()
  await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError')
  assert.equal(aborted, true)
})
