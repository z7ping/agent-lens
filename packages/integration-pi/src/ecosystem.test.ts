import assert from 'node:assert/strict'
import test from 'node:test'
import { NpmPiEcosystemProvider, piEcosystemInternals } from './ecosystem'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function searchObject(name: string, version: string, date: string, description = name) {
  return {
    package: {
      name,
      version,
      description,
      keywords: ['pi-package'],
      date,
      links: { npm: `https://www.npmjs.com/package/${name}` },
    },
  }
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

test('Pi ecosystem catalog defaults to objective monthly-download ordering without blocking on manifests', async () => {
  const requested: string[] = []
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/-/v1/search')) {
      return jsonResponse({
        total: 3,
        objects: [
          searchObject('pi-a', '1.0.0', '2026-09-15T00:00:00.000Z'),
          searchObject('pi-b', '2.0.0', '2026-09-10T00:00:00.000Z'),
          searchObject('pi-c', '3.0.0', '2026-09-17T00:00:00.000Z'),
        ],
      })
    }
    if (url.includes('api.npmjs.org/downloads/point/last-month')) {
      return jsonResponse({
        'pi-a': { downloads: 120, package: 'pi-a' },
        'pi-b': { downloads: 980, package: 'pi-b' },
        'pi-c': { downloads: 450, package: 'pi-c' },
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch

  const provider = new NpmPiEcosystemProvider(fetcher, () => Date.parse('2026-09-18T00:00:00.000Z'))
  const response = await provider.search()

  assert.equal(response.sort, 'downloads')
  assert.equal(response.upstreamTotal, 3)
  assert.deepEqual(response.items.map(item => item.packageName), ['pi-b', 'pi-c', 'pi-a'])
  assert.deepEqual(response.items.map(item => item.monthlyDownloads), [980, 450, 120])
  assert.deepEqual(response.items.map(item => item.resourceTypes), [[], [], []])
  assert.equal(requested.some(url => url.includes('registry.npmjs.org/pi-a/1.0.0')), false)

  const search = new URL(requested[0]!)
  assert.equal(search.searchParams.get('text'), 'keywords:pi-package')
  assert.equal(search.searchParams.get('size'), '250')
  assert.equal(search.searchParams.get('from'), '0')
})

test('Pi ecosystem catalog can sort by most recently published while retaining download counts', async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/-/v1/search')) {
      return jsonResponse({
        total: 3,
        objects: [
          searchObject('pi-a', '1.0.0', '2026-09-15T00:00:00.000Z'),
          searchObject('pi-b', '2.0.0', '2026-09-10T00:00:00.000Z'),
          searchObject('pi-c', '3.0.0', '2026-09-17T00:00:00.000Z'),
        ],
      })
    }
    return jsonResponse({
      'pi-a': { downloads: 120, package: 'pi-a' },
      'pi-b': { downloads: 980, package: 'pi-b' },
      'pi-c': { downloads: 450, package: 'pi-c' },
    })
  }) as typeof fetch

  const provider = new NpmPiEcosystemProvider(fetcher)
  const response = await provider.search({ sort: 'recent' })
  assert.equal(response.sort, 'recent')
  assert.deepEqual(response.items.map(item => item.packageName), ['pi-c', 'pi-a', 'pi-b'])
})

test('Pi ecosystem typed filtering walks ranked candidates and fetches exact-version manifests only as needed', async () => {
  const requested: string[] = []
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/-/v1/search')) {
      return jsonResponse({
        total: 3,
        objects: [
          searchObject('pi-a', '1.0.0', '2026-09-15T00:00:00.000Z'),
          searchObject('@example/pi-tools', '1.2.3', '2026-09-10T00:00:00.000Z'),
          searchObject('pi-c', '3.0.0', '2026-09-17T00:00:00.000Z'),
        ],
      })
    }
    if (url.includes('api.npmjs.org/downloads/point/last-month')) {
      return jsonResponse({
        'pi-a': { downloads: 1_000, package: 'pi-a' },
        '@example/pi-tools': { downloads: 800, package: '@example/pi-tools' },
        'pi-c': { downloads: 100, package: 'pi-c' },
      })
    }
    if (url.endsWith('/pi-a/1.0.0')) {
      return jsonResponse({ name: 'pi-a', version: '1.0.0', pi: { extensions: ['./extension.ts'] } })
    }
    if (url.includes('%40example%2Fpi-tools/1.2.3')) {
      return jsonResponse({
        name: '@example/pi-tools',
        version: '1.2.3',
        repository: { url: 'git+https://github.com/example/pi-tools.git' },
        pi: { extensions: ['./extensions'], skills: ['./skills'] },
      })
    }
    if (url.endsWith('/pi-c/3.0.0')) {
      return jsonResponse({ name: 'pi-c', version: '3.0.0', pi: { themes: ['./themes'] } })
    }
    throw new Error(`unexpected request: ${url}`)
  }) as typeof fetch

  const provider = new NpmPiEcosystemProvider(fetcher)
  const response = await provider.search({ query: 'tools', type: 'skill', sort: 'downloads', limit: 10 })

  assert.equal(response.items.length, 1)
  assert.deepEqual(response.items[0], {
    packageSource: 'npm:@example/pi-tools',
    packageName: '@example/pi-tools',
    version: '1.2.3',
    description: '@example/pi-tools',
    keywords: ['pi-package'],
    resourceTypes: ['extension', 'skill'],
    monthlyDownloads: 800,
    npmUrl: 'https://www.npmjs.com/package/@example/pi-tools',
    officialUrl: 'https://pi.dev/packages/%40example/pi-tools',
    repositoryUrl: 'https://github.com/example/pi-tools',
    installCommand: 'pi install npm:@example/pi-tools',
    publishedAt: '2026-09-10T00:00:00.000Z',
  })

  const search = new URL(requested[0]!)
  assert.equal(search.searchParams.get('text'), 'keywords:pi-package tools')
  assert.ok(requested.some(url => url.includes('%40example%2Fpi-tools/1.2.3')))
})

test('Pi ecosystem package details use exact version endpoint and reuse detail cache', async () => {
  let detailCalls = 0
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input)
    detailCalls += 1
    assert.ok(url.endsWith('/pi-demo/1.2.3'))
    return jsonResponse({
      name: 'pi-demo',
      version: '1.2.3',
      repository: 'https://github.com/example/pi-demo.git',
      pi: { prompts: './prompts' },
    })
  }) as typeof fetch

  const provider = new NpmPiEcosystemProvider(fetcher)
  const first = await provider.packageDetails({ packageName: 'pi-demo', version: '1.2.3' })
  const second = await provider.packageDetails({ packageName: 'pi-demo', version: '1.2.3' })

  assert.deepEqual(first, {
    packageSource: 'npm:pi-demo',
    packageName: 'pi-demo',
    version: '1.2.3',
    resourceTypes: ['prompt'],
    repositoryUrl: 'https://github.com/example/pi-demo',
  })
  assert.deepEqual(second, first)
  assert.equal(detailCalls, 1)
})

test('Pi ecosystem provider reuses short search cache and falls back to bounded last-good result', async () => {
  let now = 0
  let searchCalls = 0
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/-/v1/search')) {
      searchCalls += 1
      if (searchCalls > 1) throw new Error('offline')
      return jsonResponse({
        total: 1,
        objects: [searchObject('pi-demo', '1.0.0', '2026-09-01T00:00:00.000Z')],
      })
    }
    if (url.includes('api.npmjs.org/downloads/point/last-month')) {
      return jsonResponse({ downloads: 42, package: 'pi-demo' })
    }
    throw new Error(`unexpected request: ${url}`)
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

test('Pi ecosystem detail enrichment preserves order while bounding concurrency', async () => {
  let active = 0
  let maxActive = 0
  const values = Array.from({ length: 20 }, (_, index) => index)
  const result = await piEcosystemInternals.mapWithConcurrency(
    values,
    piEcosystemInternals.PACKAGE_DETAIL_CONCURRENCY,
    async value => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active -= 1
      return value * 2
    },
  )

  assert.deepEqual(result, values.map(value => value * 2))
  assert.ok(maxActive <= piEcosystemInternals.PACKAGE_DETAIL_CONCURRENCY)
})

test('bounded cache helper evicts the oldest entry', () => {
  const cache = new Map<string, number>()
  piEcosystemInternals.setBounded(cache, 'a', 1, 2)
  piEcosystemInternals.setBounded(cache, 'b', 2, 2)
  piEcosystemInternals.setBounded(cache, 'c', 3, 2)
  assert.deepEqual([...cache.entries()], [['b', 2], ['c', 3]])
})
