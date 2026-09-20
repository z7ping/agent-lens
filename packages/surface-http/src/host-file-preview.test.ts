import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { previewLocalHostTextFile } from './host-file-preview'

test('previews a local UTF-8 host file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-host-preview-'))
  try {
    const path = join(root, 'task-turn-rail.css')
    await writeFile(path, '.task-turn-rail { height: 2px; }\n', 'utf8')

    const preview = await previewLocalHostTextFile(path)
    assert.equal(preview.path, path)
    assert.equal(preview.name, 'task-turn-rail.css')
    assert.equal(preview.previewStatus, 'readable')
    assert.match(preview.content ?? '', /height: 2px/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('host file preview reuses managed-file sensitive-name protection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-host-preview-'))
  try {
    const path = join(root, 'credentials.txt')
    await writeFile(path, 'token=should-not-render\n', 'utf8')

    const preview = await previewLocalHostTextFile(path)
    assert.equal(preview.previewStatus, 'metadata-only')
    assert.equal(preview.blockedReason, 'sensitive')
    assert.equal(preview.content, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
