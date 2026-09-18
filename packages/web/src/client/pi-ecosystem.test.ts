import assert from 'node:assert/strict'
import test from 'node:test'
import {
  loadPiEcosystemPackageDetails,
  searchPiEcosystem,
} from './pi-ecosystem'

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('Pi ecosystem concurrent identical search shares one browser request while callers abort independently', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let calls = 0
  let release!: (value: Response) => void
  const response = new Promise<Response>(resolve => { release = resolve })
  globalThis.fetch = (async () => {
    calls += 1
    return response
  }) as typeof fetch

  const firstController = new AbortController()
  const first = searchPiEcosystem({ sort: 'downloads', limit: 20 }, firstController.signal)
  const second = searchPiEcosystem({ sort: 'downloads', limit: 20 })

  assert.equal(calls, 1)
  firstController.abort()
  await assert.rejects(first, error => error instanceof DOMException && error.name === 'AbortError')

  release(jsonResponse({
    query: '',
    sort: 'downloads',
    items: [],
    upstreamTotal: 0,
    source: 'npm-registry',
    fetchedAt: '2026-09-18T00:00:00.000Z',
    stale: false,
    meta: { protocolVersion: '1.0' },
  }))

  const result = await second
  assert.equal(result.sort, 'downloads')
  assert.equal(calls, 1)
})

test('Pi ecosystem concurrent identical package details shares one browser request', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    await new Promise(resolve => setTimeout(resolve, 5))
    return jsonResponse({
      packageSource: 'npm:pi-demo',
      packageName: 'pi-demo',
      version: '1.0.0',
      resourceTypes: ['skill'],
    })
  }) as typeof fetch

  const [first, second] = await Promise.all([
    loadPiEcosystemPackageDetails({ packageName: 'pi-demo', version: '1.0.0' }),
    loadPiEcosystemPackageDetails({ packageName: 'pi-demo', version: '1.0.0' }),
  ])

  assert.deepEqual(second, first)
  assert.equal(calls, 1)
})
