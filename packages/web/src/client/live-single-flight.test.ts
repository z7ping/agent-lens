import assert from 'node:assert/strict'
import test from 'node:test'
import { liveApi } from './live'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('Live client coalesces 100 concurrent identical GET reads', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls += 1
    await gate
    const path = String(input)
    if (path === '/api/v1/live/products') {
      return jsonResponse({ items: [] })
    }
    if (path.includes('/snapshot')) {
      return jsonResponse({
        state: {
          runtimeSessionId: 'runtime-1',
          status: 'ready',
          isStreaming: false,
          pendingMessageCount: 0,
        },
        entries: [],
      })
    }
    throw new Error(`unexpected request: ${path}`)
  }) as typeof fetch

  const products = Array.from({ length: 100 }, () => liveApi.products())
  assert.equal(calls, 1)
  release()
  await Promise.all(products)
  assert.equal(calls, 1)

  calls = 0
  let releaseSnapshot!: () => void
  const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve })
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls += 1
    await snapshotGate
    const path = String(input)
    assert.match(path, /\/snapshot$/)
    return jsonResponse({
      state: {
        runtimeSessionId: 'runtime-1',
        status: 'ready',
        isStreaming: false,
        pendingMessageCount: 0,
      },
      entries: [],
    })
  }) as typeof fetch

  const snapshots = Array.from({ length: 100 }, () => liveApi.snapshot('pi', 'runtime-1'))
  assert.equal(calls, 1)
  releaseSnapshot()
  await Promise.all(snapshots)
  assert.equal(calls, 1)
})

test('Live client never coalesces side-effecting POST requests', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let calls = 0
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1
    assert.equal(init?.method, 'POST')
    return jsonResponse({ ok: true }, 202)
  }) as typeof fetch

  await Promise.all([
    liveApi.send('pi', 'runtime-1', 'first'),
    liveApi.send('pi', 'runtime-1', 'second'),
  ])

  assert.equal(calls, 2)
})


test('Live message action reads are coalesced but executions are never coalesced', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1
    const path = String(input)
    if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
      await gate
      assert.match(path, /\/message-actions$/)
      return jsonResponse({ items: [] })
    }
    assert.equal(init?.method, 'POST')
    assert.match(path, /\/message-actions$/)
    return jsonResponse({ outcome: 'refresh-current' })
  }) as typeof fetch

  const reads = Array.from({ length: 100 }, () => liveApi.messageActions('pi', 'runtime-1'))
  assert.equal(calls, 1)
  release()
  await Promise.all(reads)
  assert.equal(calls, 1)

  calls = 0
  await Promise.all([
    liveApi.executeMessageAction('pi', 'runtime-1', 'action-1', 'entry-1'),
    liveApi.executeMessageAction('pi', 'runtime-1', 'action-1', 'entry-1'),
  ])
  assert.equal(calls, 2)
})


test('Live runtime disclosure reads coalesce while runtime action POSTs stay isolated', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls += 1
    const path = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method === 'GET') {
      await gate
      assert.match(path, /\/runtime-disclosures$/)
      return jsonResponse({ items: [] })
    }
    assert.equal(method, 'POST')
    assert.match(path, /\/runtime-actions$/)
    return jsonResponse({
      runtime: {
        runtimeSessionId: 'runtime-1',
        status: 'initializing',
        isStreaming: false,
        pendingMessageCount: 0,
      },
    })
  }) as typeof fetch

  const reads = Array.from({ length: 100 }, () => liveApi.runtimeDisclosures('pi', 'runtime-1'))
  assert.equal(calls, 1)
  release()
  await Promise.all(reads)
  assert.equal(calls, 1)

  calls = 0
  await Promise.all([
    liveApi.executeRuntimeAction('pi', 'runtime-1', 'pi.runtime.retry'),
    liveApi.executeRuntimeAction('pi', 'runtime-1', 'pi.runtime.retry'),
  ])
  assert.equal(calls, 2)
})
