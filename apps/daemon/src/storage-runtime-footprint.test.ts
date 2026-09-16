import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readRuntimeStorageFootprint } from './storage-runtime-footprint'

test('readRuntimeStorageFootprint 区分 Inbox、Temp 与尚未创建的 Content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-storage-footprint-'))
  try {
    await mkdir(join(root, 'inbox', 'codex'), { recursive: true })
    await mkdir(join(root, 'temp'), { recursive: true })
    await writeFile(join(root, 'inbox', 'codex', 'event.json'), '12345', 'utf8')
    await writeFile(join(root, 'temp', 'scratch.tmp'), '123', 'utf8')

    const footprint = await readRuntimeStorageFootprint(root)

    assert.equal(footprint.basis, 'agent-lens-data-root-filesystem')
    assert.equal(footprint.inbox.state, 'present')
    assert.equal(footprint.inbox.files, 1)
    assert.equal(footprint.inbox.bytes, 5)
    assert.equal(footprint.temp.state, 'present')
    assert.equal(footprint.temp.files, 1)
    assert.equal(footprint.temp.bytes, 3)
    assert.equal(footprint.content.state, 'not-created')
    assert.equal(footprint.content.bytes, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
