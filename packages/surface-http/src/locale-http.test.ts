import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { discoverLocalePacks } from './locale-http'

test('discovers valid JSON locale packs and isolates invalid ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-locale-'))
  try {
    await writeFile(join(root, 'en-US.json'), JSON.stringify({
      locale: 'en-US',
      name: 'English',
      agentLensLocaleVersion: 1,
      messages: { 'common.close': 'Close' },
    }))
    await writeFile(join(root, 'bad.json'), JSON.stringify({
      locale: 'zh-CN',
      name: 'Override',
      agentLensLocaleVersion: 1,
      messages: { 'common.close': 'x' },
    }))
    await writeFile(join(root, 'ignored.js'), 'throw new Error("must never execute")')

    const result = await discoverLocalePacks(root)
    assert.deepEqual(result.items.map(item => item.locale), ['en-US'])
    assert.deepEqual(result.failures.map(item => item.fileName), ['bad.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
