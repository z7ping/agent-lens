import assert from 'node:assert/strict'
import test from 'node:test'
import { AGENT_LENS_PROTOCOL_VERSION } from '@agent-lens/protocol'
import { AgentLensApi } from './api'
import {
  fetchHubReviewDetail,
  fetchLocalReviewSessions,
} from './hub-review'
import { fetchLaunchableProjects } from './launchable-projects'

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('launchable project discovery shares an identical request while caller abort remains local', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  globalThis.fetch = (async () => {
    calls += 1
    await gate
    return jsonResponse({
      items: [],
      meta: {
        protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
        count: 0,
        hasMore: false,
        generatedAt: '2026-09-18T00:00:00.000Z',
      },
    })
  }) as typeof fetch

  const controller = new AbortController()
  const first = fetchLaunchableProjects({ limit: 20, signal: controller.signal })
  const second = fetchLaunchableProjects({ limit: 20 })
  assert.equal(calls, 1)

  controller.abort()
  await assert.rejects(first, error => error instanceof DOMException && error.name === 'AbortError')
  release()
  await second
  assert.equal(calls, 1)
})

test('Hub Review detail and local list coalesce 100 concurrent identical reads', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const calls = new Map<string, number>()
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input)
    calls.set(path, (calls.get(path) ?? 0) + 1)
    await new Promise(resolve => setTimeout(resolve, 5))
    if (path.startsWith('/api/v1/hub/review/')) {
      return jsonResponse({ id: 'remote-1' })
    }
    if (path === '/api/v1/review?limit=200') {
      return jsonResponse({ items: [], meta: {} })
    }
    throw new Error(`unexpected request: ${path}`)
  }) as typeof fetch

  await Promise.all(Array.from({ length: 100 }, () => fetchHubReviewDetail('remote-1')))
  await Promise.all(Array.from({ length: 100 }, () => fetchLocalReviewSessions(200)))

  assert.equal(calls.get('/api/v1/hub/review/remote-1?limit=500'), 1)
  assert.equal(calls.get('/api/v1/review?limit=200'), 1)
})

test('usage and insights aggregate reads coalesce 100 concurrent identical requests', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const calls = new Map<string, number>()
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input)
    calls.set(path, (calls.get(path) ?? 0) + 1)
    await new Promise(resolve => setTimeout(resolve, 5))
    return jsonResponse({})
  }) as typeof fetch

  const api = new AgentLensApi()
  const filters = { sourceIds: null, projectId: '', range: '7d' as const }

  const firstUsage = api.usage(filters)
  await new Promise(resolve => setTimeout(resolve, 2))
  await Promise.all([
    firstUsage,
    ...Array.from({ length: 99 }, () => api.usage(filters)),
  ])

  const firstInsights = api.insights(filters)
  await new Promise(resolve => setTimeout(resolve, 2))
  await Promise.all([
    firstInsights,
    ...Array.from({ length: 99 }, () => api.insights(filters)),
  ])

  assert.equal(calls.size, 2)
  assert.equal([...calls.values()].every(count => count === 1), true)
})

test('managed asset directory and preview reads coalesce identical concurrent requests', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const calls = new Map<string, number>()
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input)
    calls.set(path, (calls.get(path) ?? 0) + 1)
    await new Promise(resolve => setTimeout(resolve, 5))
    return jsonResponse({})
  }) as typeof fetch

  const api = new AgentLensApi()
  await Promise.all(Array.from({ length: 100 }, () =>
    api.managedAssetDirectory('pi', 'installation-1', 'binding', '', 'binding-1'),
  ))
  await Promise.all(Array.from({ length: 100 }, () =>
    api.managedAssetFile('pi', 'installation-1', 'binding', 'SKILL.md', 'binding-1'),
  ))

  assert.equal(calls.size, 2)
  assert.equal([...calls.values()].every(count => count === 1), true)
})


test('review process exact reads coalesce identical revision requests', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let calls = 0
  globalThis.fetch = (async input => {
    const path = String(input)
    if (path === '/api/v1/review/session-1?ordinal=3&process=full') {
      calls += 1
      await Promise.resolve()
      return jsonResponse({
        id: 'session-1',
        installationId: 'install-1',
        productId: 'codex',
        sourceIds: ['codex'],
        startedAt: '2026-09-01T00:00:00.000Z',
        endedAt: '2026-09-01T00:00:01.000Z',
        durationMs: 1000,
        observationCount: 1,
        interactionCount: 1,
        toolCount: 0,
        errorCount: 0,
        hasErrors: false,
        interactions: [{
          id: 'round-3',
          ordinal: 3,
          trigger: 'user',
          startedAt: '2026-09-01T00:00:00.000Z',
          endedAt: '2026-09-01T00:00:01.000Z',
          nodes: [],
        }],
        page: { count: 1, hasMore: false, direction: 'forward', filter: 'all' },
      })
    }
    throw new Error(`unexpected request: ${path}`)
  }) as typeof fetch

  const api = new AgentLensApi()
  const results = await Promise.all(Array.from({ length: 100 }, () =>
    api.reviewProcessDetail('session-1', 3, 'revision-1')))
  assert.equal(calls, 1)
  assert.equal(results.every(item => item?.ordinal === 3), true)
})


test('review process caller abort cancels underlying request when no shared caller remains', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let aborted = false
  globalThis.fetch = ((_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      aborted = true
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })) as typeof fetch

  const api = new AgentLensApi()
  const controller = new AbortController()
  const pending = api.reviewProcessDetail('session-abort', 9, 'revision-abort', controller.signal)
  controller.abort()
  await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError')
  assert.equal(aborted, true)
})

test('review process shared request survives one caller abort and aborts after the final caller leaves', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let calls = 0
  let aborted = false
  globalThis.fetch = ((_input, init) => {
    calls += 1
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new DOMException('aborted', 'AbortError'))
      }, { once: true })
    })
  }) as typeof fetch

  const api = new AgentLensApi()
  const first = new AbortController()
  const second = new AbortController()
  const p1 = api.reviewProcessDetail('session-shared-abort', 4, 'revision-shared', first.signal)
  const p2 = api.reviewProcessDetail('session-shared-abort', 4, 'revision-shared', second.signal)
  first.abort()
  await assert.rejects(p1, error => error instanceof DOMException && error.name === 'AbortError')
  assert.equal(calls, 1)
  assert.equal(aborted, false)
  second.abort()
  await assert.rejects(p2, error => error instanceof DOMException && error.name === 'AbortError')
  assert.equal(aborted, true)
})
