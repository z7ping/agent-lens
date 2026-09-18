import assert from 'node:assert/strict'
import test from 'node:test'
import { PiDevEcosystemProvider, piEcosystemInternals } from './ecosystem'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function htmlResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { 'content-type': 'text/html' },
  })
}

function catalogHtml(): string {
  return `<!doctype html><html><body>
    <div class="packages-count">1-2 / 2</div>
    <article data-package-card="true"
      data-package-name="pi-mcp-adapter"
      data-package-types="extension skill"
      data-package-downloads="761442"
      data-package-date="1788297067693">
      <h3 class="packages-name"><a href="/packages/pi-mcp-adapter?type=extension">pi-mcp-adapter</a></h3>
      <p class="packages-desc">MCP adapter &amp; tools</p>
      <a href="https://www.npmjs.com/package/pi-mcp-adapter">npm</a>
      <a href="https://github.com/example/pi-mcp-adapter">repo</a>
      <a href="https://github.com/earendil-works/pi/issues/new?package-name=pi-mcp-adapter&amp;package-version=2.32.1">report</a>
    </article>
    <article data-package-card="true"
      data-package-name="@example/pi-theme"
      data-package-types="theme"
      data-package-downloads="123"
      data-package-date="1788000000000">
      <h3 class="packages-name"><a href="/packages/%40example/pi-theme?type=theme">@example/pi-theme</a></h3>
      <p class="packages-desc">Theme</p>
      <a href="https://www.npmjs.com/package/@example/pi-theme">npm</a>
      <a href="https://github.com/example/pi-theme">repo</a>
      <a href="https://github.com/earendil-works/pi/issues/new?package-name=%40example%2Fpi-theme&amp;package-version=1.4.0">report</a>
    </article>
  </body></html>`
}

test('Pi official catalog parser extracts list fields including embedded package version', () => {
  const parsed = piEcosystemInternals.parsePiCatalogHtml(catalogHtml())

  assert.equal(parsed.total, 2)
  assert.deepEqual(parsed.items[0], {
    packageSource: 'npm:pi-mcp-adapter',
    packageName: 'pi-mcp-adapter',
    version: '2.32.1',
    description: 'MCP adapter & tools',
    keywords: [],
    resourceTypes: ['extension', 'skill'],
    monthlyDownloads: 761442,
    npmUrl: 'https://www.npmjs.com/package/pi-mcp-adapter',
    officialUrl: 'https://pi.dev/packages/pi-mcp-adapter?type=extension',
    repositoryUrl: 'https://github.com/example/pi-mcp-adapter',
    installCommand: 'pi install npm:pi-mcp-adapter',
    publishedAt: new Date(1788297067693).toISOString(),
  })
  assert.equal(parsed.items[1]?.version, '1.4.0')
})

test('Pi official catalog URL delegates search, type and sort to pi.dev', () => {
  assert.equal(
    piEcosystemInternals.catalogUrl('mcp', 'extension', 'downloads'),
    'https://pi.dev/packages?name=mcp&type=extension',
  )
  assert.equal(
    piEcosystemInternals.catalogUrl('', undefined, 'recent'),
    'https://pi.dev/packages?sort=recent',
  )
})

test('Pi ecosystem search uses one official Catalog request and no npm search/download APIs', async () => {
  const requested: string[] = []
  const fetcher = (async (input: string | URL | Request) => {
    requested.push(String(input))
    return htmlResponse(catalogHtml())
  }) as typeof fetch

  const provider = new PiDevEcosystemProvider(fetcher, () => Date.parse('2026-09-18T00:00:00.000Z'))
  const response = await provider.search({ sort: 'downloads', limit: 20 })

  assert.equal(response.source, 'pi-dev')
  assert.equal(response.upstreamTotal, 2)
  assert.equal(response.items.length, 2)
  assert.equal(response.stale, false)
  assert.deepEqual(requested, ['https://pi.dev/packages'])
  assert.equal(requested.some(url => url.includes('registry.npmjs.org/-/v1/search')), false)
  assert.equal(requested.some(url => url.includes('api.npmjs.org/downloads')), false)
})

test('Pi ecosystem concurrent identical catalog search is single-flight', async () => {
  let calls = 0
  const fetcher = (async () => {
    calls += 1
    await new Promise(resolve => setTimeout(resolve, 10))
    return htmlResponse(catalogHtml())
  }) as typeof fetch

  const provider = new PiDevEcosystemProvider(fetcher)
  const [first, second] = await Promise.all([
    provider.search({ sort: 'downloads', limit: 20 }),
    provider.search({ sort: 'downloads', limit: 20 }),
  ])

  assert.deepEqual(second, first)
  assert.equal(calls, 1)
})

test('Pi ecosystem reuses fresh catalog cache and falls back to last good result', async () => {
  let now = 0
  let calls = 0
  let fail = false
  const fetcher = (async () => {
    calls += 1
    if (fail) throw new Error('pi.dev unavailable')
    return htmlResponse(catalogHtml())
  }) as typeof fetch

  const provider = new PiDevEcosystemProvider(fetcher, () => now)
  const first = await provider.search()
  const cached = await provider.search()
  assert.equal(calls, 1)
  assert.equal(cached.stale, false)

  now = piEcosystemInternals.CATALOG_CACHE_TTL_MS + 1
  fail = true
  const stale = await provider.search()
  assert.equal(calls, 2)
  assert.equal(stale.stale, true)
  assert.equal(stale.fetchedAt, first.fetchedAt)
})

test('Pi ecosystem hard deadline settles even when an upstream operation ignores abort', async () => {
  assert.equal(piEcosystemInternals.CATALOG_TIMEOUT_MS, 6_000)
  await assert.rejects(
    piEcosystemInternals.withinDeadline(20, 'test catalog', async () => new Promise<never>(() => undefined)),
    /test catalog timed out after 20ms/,
  )
})

test('Pi ecosystem package details still use exact npm version only on demand', async () => {
  let calls = 0
  const fetcher = (async (input: string | URL | Request) => {
    calls += 1
    const url = String(input)
    assert.ok(url.endsWith('/pi-demo/1.2.3'))
    return jsonResponse({
      name: 'pi-demo',
      version: '1.2.3',
      repository: 'https://github.com/example/pi-demo.git',
      pi: { prompts: ['./prompts'] },
    })
  }) as typeof fetch

  const provider = new PiDevEcosystemProvider(fetcher)
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
  assert.equal(calls, 1)
})

test('official catalog parser tolerates cards without report version metadata', () => {
  const parsed = piEcosystemInternals.parsePiCatalogHtml(`
    <div class="packages-count">1-1 / 1</div>
    <article data-package-card="true" data-package-name="pi-demo" data-package-types="skill">
      <h3 class="packages-name"><a href="/packages/pi-demo">pi-demo</a></h3>
      <p class="packages-desc">Demo</p>
    </article>
  `)
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0]?.version, undefined)
})
