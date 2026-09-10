import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { cliInternals } from './index'

test('CLI node version comparison honors the 22.23 floor', () => {
  assert.deepEqual(cliInternals.parseNodeVersion('v22.23.1'), [22, 23, 1])
  assert.equal(cliInternals.versionAtLeast([22, 23, 0], [22, 23, 0]), true)
  assert.equal(cliInternals.versionAtLeast([23, 0, 0], [22, 23, 0]), true)
  assert.equal(cliInternals.versionAtLeast([22, 22, 9], [22, 23, 0]), false)
})

test('CLI hook target parser keeps all as the default', () => {
  assert.equal(cliInternals.targetFrom(undefined), 'all')
  assert.equal(cliInternals.targetFrom('all'), 'all')
  assert.equal(cliInternals.targetFrom('codex'), 'codex')
  assert.equal(cliInternals.targetFrom('claude'), 'claude')
  assert.throws(() => cliInternals.targetFrom('pi'), /Unknown hook target/)
})

test('CLI runtime owner parser tolerates old health payloads', () => {
  assert.equal(cliInternals.runtimeOwner({ protocolVersion: '1.0' }), null)
  assert.equal(cliInternals.runtimeOwner({ runtime: { owner: 'desktop' } }), 'desktop')
  assert.equal(cliInternals.runtimeOwner({ runtime: { owner: 'service' } }), 'service')
  assert.equal(cliInternals.runtimeOwner({ runtime: null }), null)
})

test('CLI source detection roots use the canonical Source location resolver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-cli-source-'))
  const codex = join(root, 'codex')
  const claudePrimary = join(root, 'claude-primary')
  const claudeLegacy = join(root, 'claude-legacy')
  const piAgent = join(root, 'pi-agent')
  await Promise.all([codex, claudePrimary, claudeLegacy, piAgent].map(path => mkdir(path, { recursive: true })))

  const previous = {
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CODE_HOME: process.env.CLAUDE_CODE_HOME,
    CLAUDE_HOME: process.env.CLAUDE_HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  }
  try {
    process.env.CODEX_HOME = codex
    process.env.CLAUDE_CODE_HOME = claudePrimary
    process.env.CLAUDE_HOME = claudeLegacy
    process.env.PI_CODING_AGENT_DIR = piAgent

    const roots = new Map(cliInternals.sourceRoots().map(item => [item.source, item]))
    assert.equal(roots.get('codex')?.root, codex)
    assert.equal(roots.get('claude')?.root, claudePrimary)
    assert.equal(roots.get('pi')?.root, piAgent)
    assert.equal(roots.get('codex')?.detected, true)
    assert.equal(roots.get('claude')?.detected, true)
    assert.equal(roots.get('pi')?.detected, true)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('CLI setup only installs hooks for detected sources that need repair', () => {
  const sources = [
    { source: 'codex' as const, detected: true },
    { source: 'claude' as const, detected: false },
    { source: 'pi' as const, detected: true },
  ]
  assert.deepEqual(cliInternals.setupHookTargets(sources, [
    { target: 'codex', installed: false, trusted: false },
    { target: 'claude', installed: false },
  ]), ['codex'])

  assert.deepEqual(cliInternals.setupHookTargets([
    { source: 'codex' as const, detected: true },
    { source: 'claude' as const, detected: true },
  ], [
    { target: 'codex', installed: true, trusted: false },
    { target: 'claude', installed: true },
  ]), ['codex'])

  assert.deepEqual(cliInternals.setupHookTargets([
    { source: 'codex' as const, detected: true },
    { source: 'claude' as const, detected: true },
  ], [
    { target: 'codex', installed: true, trusted: true },
    { target: 'claude', installed: true },
  ]), [])
})

test('CLI lifecycle summary exposes Windows hidden-window state', () => {
  assert.equal(
    cliInternals.lifecycleDetail({
      manager: 'windows-task-scheduler',
      registered: true,
      active: true,
      autostart: true,
      hidden: true,
      detail: 'Running',
    }),
    'Windows 用户级计划任务 · 已注册 · 运行中 · 登录自启已启用 · 隐藏窗口 · Running',
  )
})
