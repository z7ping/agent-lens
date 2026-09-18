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

  await Promise.all(Array.from({ length: 100 }, () => api.usage(filters)))
  await Promise.all(Array.from({ length: 100 }, () => api.insights(filters)))

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
