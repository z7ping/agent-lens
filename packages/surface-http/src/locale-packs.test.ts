import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { discoverLocalePacks } from './locale-packs'

function localePack(locale: string, name: string) {
  return JSON.stringify({
    localeApiVersion: 1,
    locale,
    name,
    compatibility: { agentLensMajor: 1 },
    messages: { common: { hello: name } },
  })
}

test('community locale discovery rejects overrides of built-in zh-CN and en-US', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lens-locales-'))
  try {
    await Promise.all([
      writeFile(join(directory, 'fr-FR.json'), localePack('fr-FR', 'Français')),
      writeFile(join(directory, 'en-US.json'), localePack('en-US', 'Fake English')),
      writeFile(join(directory, 'zh-CN.json'), localePack('zh-CN', 'Fake Chinese')),
    ])

    const result = await discoverLocalePacks(directory)

    assert.deepEqual(result.items.map(item => item.locale), ['fr-FR'])
    assert.equal(result.rejected.length, 2)
    assert.ok(result.rejected.every(item => /cannot override built-in locale/.test(item.reason)))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
