import assert from 'node:assert/strict'
import test from 'node:test'
import { expectedReleaseAssets, validateReleaseAssets } from './check-release-assets.mjs'

test('完整候选产物允许晋升', () => {
  const version = '1.0.0-alpha.2'
  const tag = `v${version}`
  const release = {
    tagName: tag,
    isDraft: true,
    isPrerelease: true,
    body: `## AgentLens ${tag}`,
    assets: expectedReleaseAssets(version).map(name => ({ name })),
  }
  assert.deepEqual(validateReleaseAssets({ release, version, tag }), [])
})

test('缺少任一平台产物都会阻止晋升', () => {
  const version = '1.0.0-alpha.2'
  const tag = `v${version}`
  const assets = expectedReleaseAssets(version).filter(name => !name.endsWith('Setup-x64.exe'))
  const failures = validateReleaseAssets({
    version,
    tag,
    release: {
      tagName: tag,
      isDraft: true,
      isPrerelease: true,
      body: `## AgentLens ${tag}`,
      assets: assets.map(name => ({ name })),
    },
  })
  assert.equal(failures.length, 1)
  assert.match(failures[0], /Setup-x64\.exe/)
})
