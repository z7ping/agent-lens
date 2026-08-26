import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareSemver,
  fetchAvailableUpdate,
  parseSemver,
  selectUpdateRelease,
  shouldCheckForUpdate,
} from './update-check.mjs'

test('parseSemver and compareSemver follow prerelease precedence', () => {
  assert.equal(parseSemver('v1.0.0-alpha.1')?.prerelease.join('.'), 'alpha.1')
  assert.ok(compareSemver('1.0.0-alpha.0', '1.0.0-alpha.1') < 0)
  assert.ok(compareSemver('1.0.0-alpha.9', '1.0.0-beta.0') < 0)
  assert.ok(compareSemver('1.0.0-beta.2', '1.0.0-rc.1') < 0)
  assert.ok(compareSemver('1.0.0-rc.1', '1.0.0') < 0)
  assert.ok(compareSemver('1.0.1', '1.0.0') > 0)
})

test('stable builds ignore prereleases', () => {
  const update = selectUpdateRelease([
    { tag_name: 'v1.1.0-beta.0', prerelease: true, draft: false, html_url: 'https://example.test/beta', assets: [] },
    { tag_name: 'v1.0.1', prerelease: false, draft: false, html_url: 'https://example.test/stable', assets: [] },
  ], '1.0.0')
  assert.equal(update?.version, '1.0.1')
})

test('prerelease builds can advance through later prereleases into stable', () => {
  const update = selectUpdateRelease([
    { tag_name: 'v1.0.0-alpha.1', prerelease: true, draft: false, html_url: 'https://example.test/a1', assets: [] },
    { tag_name: 'v1.0.0-rc.1', prerelease: true, draft: false, html_url: 'https://example.test/rc1', assets: [] },
    {
      tag_name: 'v1.0.0',
      prerelease: false,
      draft: false,
      html_url: 'https://example.test/stable',
      assets: [{ name: 'AgentLens-1.0.0-Setup-x64.exe', browser_download_url: 'https://example.test/setup.exe' }],
    },
  ], '1.0.0-alpha.0')
  assert.equal(update?.version, '1.0.0')
  assert.equal(update?.downloadUrl, 'https://example.test/setup.exe')
})

test('drafts, malformed tags and older releases are ignored', () => {
  const update = selectUpdateRelease([
    { tag_name: 'v9.0.0', draft: true, prerelease: false, html_url: 'https://example.test/draft' },
    { tag_name: 'nightly', draft: false, prerelease: false, html_url: 'https://example.test/nightly' },
    { tag_name: 'v0.9.9', draft: false, prerelease: false, html_url: 'https://example.test/old' },
  ], '1.0.0-alpha.0')
  assert.equal(update, null)
})

test('daily check interval is persisted as a 24 hour gate', () => {
  const now = Date.parse('2026-08-26T10:00:00Z')
  assert.equal(shouldCheckForUpdate(null, now), true)
  assert.equal(shouldCheckForUpdate('2026-08-25T11:00:00Z', now), false)
  assert.equal(shouldCheckForUpdate('2026-08-25T10:00:00Z', now), true)
})

test('fetchAvailableUpdate uses release list and returns selected update', async () => {
  const update = await fetchAvailableUpdate('1.0.0-alpha.0', {
    signal: AbortSignal.timeout(1000),
    fetchImpl: async (url, init) => {
      assert.match(url, /\/releases\?per_page=20$/)
      assert.equal(init.headers['User-Agent'], 'AgentLens/1.0.0-alpha.0')
      return {
        ok: true,
        json: async () => [{ tag_name: 'v1.0.0-alpha.1', prerelease: true, draft: false, html_url: 'https://example.test/a1', assets: [] }],
      }
    },
  })
  assert.equal(update?.version, '1.0.0-alpha.1')
})
