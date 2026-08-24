import assert from 'node:assert/strict'
import test from 'node:test'
import { hookExecutionInternals, windowsDispatcherCommand } from './hook-execution'

test('Windows Hook 命令固定指向用户级共享分发器', () => {
  const dispatcher = 'C:\\Users\\tester\\.agent-lens\\1.0\\runtime\\windows-hook-dispatcher.ps1'
  const codex = windowsDispatcherCommand(dispatcher, 'codex')
  const claude = windowsDispatcherCommand(dispatcher, 'claude')

  assert.match(codex, /^powershell\.exe /)
  assert.match(codex, /-WindowStyle Hidden/)
  assert.match(codex, /-ExecutionPolicy Bypass/)
  assert.match(codex, /windows-hook-dispatcher\.ps1/)
  assert.match(codex, /agent-lens-hook-codex$/)
  assert.match(claude, /agent-lens-hook-claude$/)
  assert.doesNotMatch(codex, /node\.exe/)
})

test('源码 CLI 不冒充正式 npm 安装，正式 mjs 与 Desktop 可以登记', () => {
  const source = hookExecutionInternals.distributionContext(
    'file:///workspace/apps/cli/src/index.ts',
    'C:\\Program Files\\nodejs\\node.exe',
    {},
  )
  assert.equal(source.kind, 'npm')
  assert.equal(source.formalDistribution, false)

  const npm = hookExecutionInternals.distributionContext(
    'file:///workspace/dist/cli.mjs',
    'C:\\Program Files\\nodejs\\node.exe',
    {},
  )
  assert.equal(npm.kind, 'npm')
  assert.equal(npm.formalDistribution, true)

  const desktop = hookExecutionInternals.distributionContext(
    'file:///resources/app.asar.unpacked/runtime/cli.mjs',
    'C:\\AgentLens\\AgentLens.exe',
    { AGENT_LENS_DISTRIBUTION: 'desktop' },
  )
  assert.equal(desktop.kind, 'desktop')
  assert.equal(desktop.formalDistribution, true)
  assert.equal(desktop.electronRunAsNode, true)
})
