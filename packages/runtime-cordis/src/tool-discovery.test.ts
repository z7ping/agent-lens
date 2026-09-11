import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  discoverOfficialTools,
  OfficialToolDiscoveryService,
} from './tool-discovery'

test('tool discovery reports present from executable evidence without running the Agent CLI', async () => {
  const calls: string[] = []
  const items = await discoverOfficialTools({
    env: { PATH: '' },
    homeDir: join(tmpdir(), 'agent-lens-no-product-data'),
    platform: process.platform,
    timeoutMs: 1_000,
    shellPathResolver: async () => undefined,
    executableResolver: async name => {
      calls.push(name)
      return name === 'pi' ? '/opt/bin/pi' : undefined
    },
  })
  const pi = items.find(item => item.integrationId === 'pi')
  assert.equal(pi?.presence, 'present')
  assert.equal(pi?.executable, '/opt/bin/pi')
  assert.ok(calls.includes('pi'))
})

test('tool discovery reports data-only when persisted product data exists without an executable', async () => {
  const root = join(tmpdir(), `agent-lens-tool-discovery-${process.pid}-${Date.now()}`)
  const home = join(root, 'home')
  const codexHome = join(root, 'codex')
  await mkdir(join(codexHome, 'sessions'), { recursive: true })
  try {
    const items = await discoverOfficialTools({
      env: {
        CODEX_HOME: codexHome,
        PATH: '',
      },
      homeDir: home,
      platform: process.platform,
      timeoutMs: 1_000,
      shellPathResolver: async () => undefined,
      executableResolver: async () => undefined,
    })
    const codex = items.find(item => item.integrationId === 'codex')
    assert.equal(codex?.presence, 'data-only')
    assert.equal(codex?.configRoot, codexHome)
    assert.equal(codex?.dataRoot, join(codexHome, 'sessions'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('OpenCode database marker is required before a data directory becomes product evidence', async () => {
  const root = join(tmpdir(), `agent-lens-opencode-discovery-${process.pid}-${Date.now()}`)
  const home = join(root, 'home')
  const data = join(root, 'opencode')
  await mkdir(data, { recursive: true })
  try {
    let items = await discoverOfficialTools({
      env: { OPENCODE_HOME: data, PATH: '' },
      homeDir: home,
      platform: process.platform,
      timeoutMs: 1_000,
      shellPathResolver: async () => undefined,
      executableResolver: async () => undefined,
    })
    assert.equal(items.find(item => item.integrationId === 'opencode')?.presence, 'absent')

    await writeFile(join(data, 'opencode.db'), '')
    items = await discoverOfficialTools({
      env: { OPENCODE_HOME: data, PATH: '' },
      homeDir: home,
      platform: process.platform,
      timeoutMs: 1_000,
      shellPathResolver: async () => undefined,
      executableResolver: async () => undefined,
    })
    assert.equal(items.find(item => item.integrationId === 'opencode')?.presence, 'data-only')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('discovery service exposes scanning state and coalesces concurrent rescans', async () => {
  const service = new OfficialToolDiscoveryService({
    env: { PATH: '' },
    homeDir: join(tmpdir(), 'agent-lens-empty-home'),
    platform: process.platform,
    timeoutMs: 1_000,
    shellPathResolver: async () => undefined,
    executableResolver: async () => undefined,
  })
  assert.equal(service.snapshot().status, 'idle')
  const first = service.rescan()
  const second = service.rescan()
  assert.equal(first, second)
  assert.equal(service.snapshot().status, 'scanning')
  const completed = await first
  assert.equal(completed.status, 'complete')
  assert.equal(completed.items.length, 5)
  assert.equal(typeof completed.completedAt, 'string')
})
