import assert from 'node:assert/strict'
import test from 'node:test'
import { liveApi, LiveRequestError } from './live'

test('Live history resume preserves structured native writer conflict reason', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'capability_unavailable',
    message: '该会话已有其他客户端持有写入权。',
    reasonCode: 'codex_thread_active_writer',
  }), { status: 409, headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(liveApi.resume('codex', 'logical-desktop-session'), error => {
      assert.equal(error instanceof LiveRequestError, true)
      assert.equal((error as LiveRequestError).reasonCode, 'codex_thread_active_writer')
      assert.match((error as Error).message, /写入权/)
      return true
    })
  } finally {
    globalThis.fetch = original
  }
})

test('Live request failures without a reason remain readable and safe', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'bad_request', message: 'unknown source' }),
    { status: 400, headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(liveApi.resume('codex', 'unknown-session'), error => {
      assert.equal(error instanceof LiveRequestError, true)
      assert.equal((error as LiveRequestError).reasonCode, undefined)
      assert.equal((error as Error).message, 'unknown source')
      return true
    })
  } finally {
    globalThis.fetch = original
  }
})
