import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Host, SourceDetectionContext } from '@agent-lens/core'
import { detectPi } from './index'

const host: Host = {
  id: 'host-pi-detection-test',
  name: 'pi-detection-test',
  platform: process.platform,
  arch: process.arch,
  createdAt: '2026-09-10T00:00:00.000Z',
  lastSeenAt: '2026-09-10T00:00:00.000Z',
}

function context(env: SourceDetectionContext['env']): SourceDetectionContext {
  return env === undefined ? { host } : { host, env }
}

async function executable(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\nexit 0\n', 'utf8')
  if (process.platform !== 'win32') await chmod(path, 0o755)
}

test('Pi Source honors PI_BIN through unified executable discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-detect-'))
  try {
    const bin = join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi')
    await executable(bin)

    const [detected] = await detectPi(context({ PI_HOME: root, PI_BIN: bin, PATH: '' }))

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

    const [detected] = await detectPi(context({ PI_HOME: root, PATH: binDir }))

    assert.equal(detected?.executable, bin)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('Pi Source exposes provider-resolved configRoot and configured session dataRoot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-roots-'))
  const configRoot = join(root, 'agent')
  const sessionsRoot = join(root, 'custom-sessions')
  try {
    await mkdir(configRoot, { recursive: true })
    await mkdir(sessionsRoot, { recursive: true })
    await writeFile(
      join(configRoot, 'settings.json'),
      JSON.stringify({ sessionDir: sessionsRoot }),
      'utf8',
    )

    const [detected] = await detectPi(context({
      PI_CODING_AGENT_DIR: configRoot,
      PATH: '',
    }))

    assert.equal(detected?.configRoot, configRoot)
    assert.equal(detected?.dataRoot, sessionsRoot)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
