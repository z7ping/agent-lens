import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolvePiSpawnSpec } from './rpc-client'

test('Windows npm pi.cmd resolves to the owned Node CLI process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-shim-'))
  try {
    const entryDir = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle')
    const entry = join(entryDir, 'cli.js')
    await mkdir(entryDir, { recursive: true })
    await writeFile(entry, 'export {}\n', 'utf8')

    const shim = join(root, 'pi.cmd')
    await writeFile(
      shim,
      '@echo off\r\nnode "%~dp0node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n',
      'utf8',
    )

    const launch = await resolvePiSpawnSpec(shim, ['--mode', 'rpc', '--model', 'test-model'], 'win32')
    assert.equal(launch.kind, 'windows-npm-shim')
    assert.equal(launch.command, process.execPath)
    assert.deepEqual(launch.args, [entry, '--mode', 'rpc', '--model', 'test-model'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
