import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SourceDetectionContext } from '@agent-lens/core'
import { detectPi } from './index'

async function executable(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\nexit 0\n', 'utf8')
  if (process.platform !== 'win32') await chmod(path, 0o755)
}

test('Pi Source honors PI_BIN through unified executable discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-detect-'))
  try {
    const bin = join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi')
    await executable(bin)

    const [detected] = await detectPi({
      env: { PI_HOME: root, PI_BIN: bin, PATH: '' },
    } as SourceDetectionContext)

    assert.equal(detected?.executable, bin)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Pi Source uses the shared PATH discovery contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-path-'))
  try {
    const binDir = join(root, 'bin')
    await mkdir(binDir, { recursive: true })
    const bin = join(binDir, process.platform === 'win32' ? 'pi.cmd' : 'pi')
    await executable(bin)

    const [detected] = await detectPi({
      env: { PI_HOME: root, PATH: binDir },
    } as SourceDetectionContext)

    assert.equal(detected?.executable, bin)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
