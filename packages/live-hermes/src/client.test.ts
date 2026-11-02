import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesApiClient } from './client'

test('Hermes SSE resumes using the official sequence cursor without duplicating replayed deltas', async () => {
  const saved = globalThis.fetch
  const calls: RequestInit[] = []
  const first = [
    'id: 1', 'event: message.delta',
    'data: {"event":"message.delta","run_id":"run-1","seq":1,"delta":"Hello"}',
    '', '',
  ].join('\n')
  const replay = [
    'id: 1', 'event: message.delta',
    'data: {"event":"message.delta","run_id":"run-1","seq":1,"delta":"Hello"}',
    '', 'id: 2', 'event: message.delta',
    'data: {"event":"message.delta","run_id":"run-1","seq":2,"delta":" world"}',
    '', 'id: 3', 'event: run.completed',
    'data: {"event":"run.completed","run_id":"run-1","seq":3,"output":"Hello world"}',
    '', '',
  ].join('\n')
  try {
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {})
      return new Response(calls.length === 1 ? first : replay, { status: 200 })
    }) as typeof fetch
    const client = new HermesApiClient({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'test' })
    const seen: Record<string, unknown>[] = []
    for await (const item of client.runEvents('run-1')) seen.push(item)
    assert.deepEqual(seen.map(item => item.seq), [1, 2, 3])
    assert.equal(calls.length, 2)
    assert.equal((calls[1]?.headers as Record<string, string>)['Last-Event-ID'], '1')
  } finally {
    globalThis.fetch = saved
  }
})

test('Hermes snapshots load the newest chronological page rather than the oldest 500', async () => {
  const saved = globalThis.fetch
  let requested = ''
  try {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      requested = String(url)
      return new Response(JSON.stringify({ data: [{ id: 'last', role: 'assistant', content: 'latest' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    const client = new HermesApiClient({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'test' })
    const rows = await client.sessionMessages('session-1')
    assert.equal(rows.length, 1)
    assert.match(requested, /order=latest&limit=500&include_compacted=true/)
  } finally {
    globalThis.fetch = saved
  }
})
