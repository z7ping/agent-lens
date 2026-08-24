import assert from 'node:assert/strict'
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
