import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PiWorkspaceFileReferenceIndex,
  piWorkspaceFileReferenceInternals,
  workspaceFileReferenceValue,
} from './workspace-files'

test('workspace file references stay relative and quote paths with spaces', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-workspace-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'docs', 'user guide'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true })
  await writeFile(join(root, 'src', 'index.ts'), 'export {}')
  await writeFile(join(root, 'docs', 'user guide', 'intro.md'), '# Intro')
  await writeFile(join(root, 'node_modules', 'ignored', 'index.js'), 'ignored')

  const index = new PiWorkspaceFileReferenceIndex()
  assert.deepEqual(await index.search(root, 'index', 20), [
    { path: 'src/index.ts', value: '@src/index.ts' },
  ])
  assert.deepEqual(await index.search(root, 'user guide', 20), [
    { path: 'docs/user guide/intro.md', value: '@"docs/user guide/intro.md"' },
  ])
  assert.equal(workspaceFileReferenceValue('docs/a b.md'), '@"docs/a b.md"')
})

test('workspace file reference index is bounded and cached briefly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-workspace-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'first.txt'), 'first')

  let now = 0
  const index = new PiWorkspaceFileReferenceIndex(() => now)
  assert.deepEqual(await index.search(root, 'first'), [
    { path: 'first.txt', value: '@first.txt' },
  ])

  await writeFile(join(root, 'second.txt'), 'second')
  assert.deepEqual(await index.search(root, 'second'), [])

  now = piWorkspaceFileReferenceInternals.CACHE_TTL_MS + 1
  assert.deepEqual(await index.search(root, 'second'), [
    { path: 'second.txt', value: '@second.txt' },
  ])
})

test('workspace reference search supports nested path queries and result limits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-workspace-nested-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src', 'feature'), { recursive: true })
  await writeFile(join(root, 'src', 'feature', 'alpha.ts'), 'a')
  await writeFile(join(root, 'src', 'feature', 'beta.ts'), 'b')

  const index = new PiWorkspaceFileReferenceIndex()
  const result = await index.search(root, 'src/feature', 1)
  assert.equal(result.length, 1)
  assert.ok(result[0]?.path.startsWith('src/feature/'))
})
