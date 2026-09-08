import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { validatePiLiveWorkspace } from './workspace-validation'

test('Pi Live workspace preflight returns a normalized existing directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-workspace-'))
  try {
    assert.equal(await validatePiLiveWorkspace(root), resolve(root))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi Live workspace preflight rejects a missing path before Worker creation', async () => {
  const missing = join(tmpdir(), `agent-lens-pi-missing-${Date.now()}`)
  await assert.rejects(
    validatePiLiveWorkspace(missing),
    error => error instanceof Error
      && error.message.includes('工作目录不存在')
      && error.message.includes(resolve(missing))
      && (error as Error & { statusCode?: number }).statusCode === 400,
  )
})

test('Pi Live workspace preflight rejects files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-workspace-file-'))
  const file = join(root, 'not-a-directory')
  try {
    await writeFile(file, 'x', 'utf8')
    await assert.rejects(
      validatePiLiveWorkspace(file),
      error => error instanceof Error
        && error.message.includes('工作目录不是文件夹')
        && (error as Error & { statusCode?: number }).statusCode === 400,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
