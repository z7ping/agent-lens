import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateHostWorkingDirectory } from './host-working-directory'

test('Live 工作目录校验只接受存在、可读写的绝对目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-directory-'))
  try {
    assert.equal(await validateHostWorkingDirectory(root), root)
    await assert.rejects(
      () => validateHostWorkingDirectory('relative/project'),
      /绝对路径/,
    )
    await assert.rejects(
      () => validateHostWorkingDirectory(join(root, 'missing')),
      /找不到项目目录/,
    )
    const filename = join(root, 'file.txt')
    await writeFile(filename, 'not a directory')
    await assert.rejects(
      () => validateHostWorkingDirectory(filename),
      /不是目录/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
