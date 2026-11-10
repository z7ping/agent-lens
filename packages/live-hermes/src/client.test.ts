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
    assert.match(requested, /order=latest&offset=0&limit=500&include_compacted=true/)
  } finally {
    globalThis.fetch = saved
  }
})


test('Hermes history traverses newest, oldest and both directions using bounded native pages', async () => {
  const saved = globalThis.fetch
  const raw = Array.from({ length: 267 }, (_, i) => ({
    id: i + 1, role: i % 2 ? 'assistant' : 'user', content: `message ${i + 1}`,
  }))
  const requests: string[] = []
  try {
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const request = new URL(String(url))
      requests.push(request.search)
      const order = request.searchParams.get('order')
      const offset = Number(request.searchParams.get('offset'))
      const limit = Number(request.searchParams.get('limit'))
      const rows = order === 'latest'
        ? raw.slice().reverse().slice(offset, offset + limit).reverse()
        : raw.slice(offset, offset + limit)
      return new Response(JSON.stringify({ data: rows }), { status: 200,
        headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    const client = new HermesApiClient({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'test' })
    const last = await client.sessionMessagesPage('session-1', { edge: 'latest', limit: 120 })
    assert.equal(last.entries.length, 120)
    assert.equal((last.entries[0] as { id: string }).id, '148')
    assert.equal((last.entries.at(-1) as { id: string }).id, '267')
    assert.equal(last.page.before, 'hermes-history:latest:120:148')
    assert.equal(last.page.hasEarlier, true)
    assert.equal(last.page.hasLater, false)

    // New rows arriving after we captured the tail must not shift the
    // older-page boundary or cause a duplicated/missing history interval.
    raw.push(...Array.from({ length: 5 }, (_, i) => ({
      id: 268 + i, role: 'assistant', content: `new message ${i}`,
    })))
    const middle = await client.sessionMessagesPage('session-1', { before: last.page.before, limit: 120 })
    assert.equal((middle.entries[0] as { id: string }).id, '28')
    assert.equal((middle.entries.at(-1) as { id: string }).id, '147')
    assert.equal(middle.page.after, 'hermes-history:latest:124:147')
    const first = await client.sessionMessagesPage('session-1', { before: middle.page.before, limit: 120 })
    assert.equal(first.entries.length, 27)
    assert.equal((first.entries[0] as { id: string }).id, '1')
    assert.equal(first.page.hasEarlier, false)
    const forward = await client.sessionMessagesPage('session-1', { after: first.page.after, limit: 120 })
    assert.deepEqual(forward.entries.map(item => (item as { id: string }).id), 
      middle.entries.map(item => (item as { id: string }).id))

    const earliest = await client.sessionMessagesPage('session-1', { edge: 'earliest', limit: 120 })
    assert.equal((earliest.entries[0] as { id: string }).id, '1')
    assert.equal((earliest.entries.at(-1) as { id: string }).id, '120')
    assert.equal(earliest.page.hasEarlier, false)
    assert.equal(earliest.page.after, 'hermes-history:oldest:120')
    const next = await client.sessionMessagesPage('session-1', { after: earliest.page.after, limit: 120 })
    assert.equal((next.entries[0] as { id: string }).id, '121')
    assert.equal((next.entries.at(-1) as { id: string }).id, '240')
    const newest = await client.sessionMessagesPage('session-1', { after: next.page.after, limit: 120 })
    assert.equal(newest.entries.length, 32)
    assert.equal(newest.page.hasLater, false)
    const backward = await client.sessionMessagesPage('session-1', { before: newest.page.before, limit: 120 })
    assert.deepEqual(backward.entries.map(item => (item as { id: string }).id),
      next.entries.map(item => (item as { id: string }).id))

    assert.ok(requests.every(value => {
      const n = Number(new URLSearchParams(value).get('limit'))
      return n >= 1 && n <= 120
    }))
  } finally {
    globalThis.fetch = saved
  }
})

test('Hermes replay.truncated preserves the official open SSE stream and emits later terminal events', async () => {
  const original = globalThis.fetch
  const frames = [
    'data: {"event":"replay.truncated","run_id":"run-1","oldest_retained_seq":502,"requested_seq":200}',
    '', 'id: 502',
    'data: {"event":"message.delta","run_id":"run-1","seq":502,"delta":"Recovered tail"}',
    '', 'id: 503',
    'data: {"event":"run.completed","run_id":"run-1","seq":503,"output":"Recovered tail"}',
    '', '',
  ].join('\n')
  try {
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response(frames, { status: 200 })
    }) as typeof fetch
    const client = new HermesApiClient({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'test' })
    const seen: Record<string, unknown>[] = []
    for await (const event of client.runEvents('run-1')) seen.push(event)
    assert.deepEqual(seen.map(event => event.event), ['replay.truncated', 'message.delta', 'run.completed'])
    assert.equal(requests, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('Hermes anchored latest paging stops safely if a boundary row disappeared', async () => {
  const saved = globalThis.fetch
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
    const client = new HermesApiClient({ apiUrl: 'http://127.0.0.1:8642', apiKey: 'test' })
    await assert.rejects(
      client.sessionMessagesPage('session-1',
        { before: 'hermes-history:latest:120:missing-anchor', limit: 120 }),
      /boundary is no longer available/,
    )
  } finally {
    globalThis.fetch = saved
  }
})
