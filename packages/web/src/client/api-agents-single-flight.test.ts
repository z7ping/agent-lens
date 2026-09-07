import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentLensApi } from './api'

test('agents concurrent refreshes share one foreground request and release after settlement', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })

  globalThis.fetch = (async () => {
    calls += 1
    await gate
    return new Response(JSON.stringify({ items: [], meta: { generatedAt: '2026-09-08T00:00:00.000Z' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const first = new AgentLensApi().agents()
    const second = new AgentLensApi().agents()
    assert.equal(calls, 1)

    release()
    await Promise.all([first, second])
    assert.equal(calls, 1)

    await new AgentLensApi().agents()
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})
