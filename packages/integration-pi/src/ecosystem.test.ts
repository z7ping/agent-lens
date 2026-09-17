import assert from 'node:assert/strict'
import test from 'node:test'
import { NpmPiEcosystemProvider, piEcosystemInternals } from './ecosystem'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('Pi ecosystem manifest parsing only claims explicitly declared resource types', () => {
  assert.deepEqual(piEcosystemInternals.resourceTypesFromManifest({
    pi: {
      extensions: ['./extensions'],
      skills: ['./skills'],
      prompts: './prompts',
      themes: [],
    },
  }), ['extension', 'skill', 'prompt'])
  assert.deepEqual(piEcosystemInternals.resourceTypesFromManifest({}), [])
})

test('Pi official package URL preserves scoped package path segments', () => {
  assert.equal(
    piEcosystemInternals.piPackageUrl('@example/pi-tools'),
    'https://pi.dev/packages/%40example/pi-tools',
  )
})

test('Pi ecosystem provider queries npm pi-package convention and maps stable package identity', async () => {
  const requested: string[] = []
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/-/v1/search')) {
      return jsonResponse({
        total: 1,
        objects: [{
          package: {
            name: '@example/pi-tools',
            version: '1.2.3',
            description: 'Example Pi tools',
            keywords: ['pi-package'],
            date: '2026-09-01T00:00:00.000Z',
            links: { npm: 'https://www.npmjs.com/package/@example/pi-tools' },
          },
        }],
      })
    }
    return jsonResponse({
      'dist-tags': { latest: '1.2.3' },
      versions: {
        '1.2.3': {
          name: '@example/pi-tools',
          version: '1.2.3',
          repository: { url: 'git+https://github.com/example/pi-tools.git' },
          pi: { extensions: ['./extensions'], skills: ['./skills'] },
        },
      },
      time: { '1.2.3': '2026-09-01T00:00:00.000Z' },
    })
  }) as typeof fetch

  const provider = new NpmPiEcosystemProvider(fetcher, () => Date.parse('2026-09-17T00:00:00.000Z'))
  const response = await provider.search({ query: 'tools', type: 'skill', limit: 10 })

  assert.equal(response.source, 'npm-registry')
  assert.equal(response.stale, false)
  assert.equal(response.items.length, 1)
  assert.deepEqual(response.items[0], {
    packageSource: 'npm:@example/pi-tools',
    packageName: '@example/pi-tools',
    version: '1.2.3',
    description: 'Example Pi tools',
    keywords: ['pi-package'],
    resourceTypes: ['extension', 'skill'],
    npmUrl: 'https://www.npmjs.com/package/@example/pi-tools',
    officialUrl: 'https://pi.dev/packages/%40example/pi-tools',
    repositoryUrl: 'https://github.com/example/pi-tools',
    installCommand: 'pi install npm:@example/pi-tools',
    publishedAt: '2026-09-01T00:00:00.000Z',
  })

  const search = new URL(requested[0]!)
  assert.equal(search.searchParams.get('text'), 'keywords:pi-package tools')
  assert.equal(search.searchParams.get('size'), '30')
})

test('Pi ecosystem provider reuses short cache and falls back to bounded last-good result', async () => {
  let now = 0
  let searchCalls = 0
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/-/v1/search')) {
      searchCalls += 1
      if (searchCalls > 1) throw new Error('offline')
      return jsonResponse({
        total: 1,
        objects: [{ package: { name: 'pi-demo', version: '1.0.0', keywords: ['pi-package'] } }],
      })
    }
    return jsonResponse({
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { pi: { extensions: ['./index.ts'] } } },
    })
  }) as typeof fetch

  const provider = new NpmPiEcosystemProvider(fetcher, () => now)
  const first = await provider.search({ query: 'demo' })
  const cached = await provider.search({ query: 'demo' })
  assert.equal(searchCalls, 1)
  assert.equal(cached.stale, false)

  now = 60_001
  const stale = await provider.search({ query: 'demo' })
  assert.equal(searchCalls, 2)
  assert.equal(stale.stale, true)
  assert.equal(stale.fetchedAt, first.fetchedAt)
})

test('bounded cache helper evicts the oldest entry', () => {
  const cache = new Map<string, number>()
  piEcosystemInternals.setBounded(cache, 'a', 1, 2)
  piEcosystemInternals.setBounded(cache, 'b', 2, 2)
  piEcosystemInternals.setBounded(cache, 'c', 3, 2)
  assert.deepEqual([...cache.entries()], [['b', 2], ['c', 3]])
})
