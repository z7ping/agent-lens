import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { browseHostWorkingDirectory } from './host-directory-browser'

test('read-only browser returns directory names without exposing ordinary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'al-browser-'))
  try {
    const child = join(root, 'subfolder')
    await mkdir(child)
    await writeFile(join(root, 'secret.txt'), 'private file content')
    const result = await browseHostWorkingDirectory(root)
    assert.equal(result.path, root)
    assert.equal(result.parentPath, dirname(root))
    assert.equal(result.breadcrumbs.at(-1)?.path, root)
    assert.deepEqual(result.directories, [{ name: 'subfolder', path: child }])
    assert.equal(result.selectable, true)
    assert.equal(result.truncated, false)
    assert.equal(JSON.stringify(result).includes('secret.txt'), false)
    assert.equal(JSON.stringify(result).includes('private file content'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('browser rejects relative, missing and file paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'al-browser-'))
  try {
    assert.equal((await browseHostWorkingDirectory(root)).path, root)
    await assert.rejects(() => browseHostWorkingDirectory('relative/path'), /绝对目录/)
    await assert.rejects(() => browseHostWorkingDirectory(join(root, 'missing')), /目录不存在/)
    const filename = join(root, 'text.txt')
    await writeFile(filename, 'file')
    await assert.rejects(() => browseHostWorkingDirectory(filename), /不是目录/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
