import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ManagedFileError,
  isPathInside,
  listManagedDirectory,
  normalizeManagedRelativePath,
  previewManagedTextFile,
} from './managed-files'

function errorCode(error: unknown): string | undefined {
  return error instanceof ManagedFileError ? error.code : undefined
}

test('managed relative paths reject absolute and traversal inputs', () => {
  assert.equal(normalizeManagedRelativePath(undefined), '')
  assert.equal(normalizeManagedRelativePath('skills/review'), 'skills/review')
  assert.throws(() => normalizeManagedRelativePath('../secret'), error => errorCode(error) === 'invalid-path')
  assert.throws(() => normalizeManagedRelativePath('/etc/passwd'), error => errorCode(error) === 'invalid-path')
  assert.throws(() => normalizeManagedRelativePath('C:\\Users\\user\\secret'), error => errorCode(error) === 'invalid-path')
})

test('managed path containment is segment-aware', () => {
  assert.equal(isPathInside('/tmp/root', '/tmp/root/file'), true)
  assert.equal(isPathInside('/tmp/root', '/tmp/root-other/file'), false)
})

test('managed directory listing is shallow and reports direct entry kinds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-managed-files-'))
  try {
    await mkdir(join(root, 'skills'), { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), '# instructions\n', 'utf8')
    await writeFile(join(root, 'skills', 'SKILL.md'), '# skill\n', 'utf8')

    const listing = await listManagedDirectory(root)
    assert.deepEqual(listing.entries.map(entry => [entry.name, entry.kind]), [
      ['skills', 'directory'],
      ['AGENTS.md', 'file'],
    ])
    assert.equal(listing.entries.some(entry => entry.relativePath === 'skills/SKILL.md'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed text preview returns safe UTF-8 text and blocks sensitive content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-managed-preview-'))
  try {
    await writeFile(join(root, 'AGENTS.md'), '# instructions\n', 'utf8')
    await writeFile(join(root, '.env'), 'TOKEN=secret\n', 'utf8')
    await writeFile(join(root, 'config.toml'), 'api_key = "super-secret-value"\n', 'utf8')
    await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]))

    assert.equal((await previewManagedTextFile(root, 'AGENTS.md')).content, '# instructions\n')
    await assert.rejects(previewManagedTextFile(root, '.env'), error => errorCode(error) === 'sensitive')
    await assert.rejects(previewManagedTextFile(root, 'config.toml'), error => errorCode(error) === 'sensitive')
    await assert.rejects(previewManagedTextFile(root, 'binary.bin'), error => errorCode(error) === 'binary')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('managed text preview enforces size limit before returning content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-managed-size-'))
  try {
    await writeFile(join(root, 'large.txt'), '1234567890', 'utf8')
    await assert.rejects(previewManagedTextFile(root, 'large.txt', 5), error => errorCode(error) === 'too-large')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
