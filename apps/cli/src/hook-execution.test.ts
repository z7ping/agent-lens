import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hookExecutionInternals, windowsDispatcherCommand } from './hook-execution'

function fixtureModuleUrl(...parts: string[]): string {
  return pathToFileURL(resolve(...parts)).href
}

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

test('Windows 共享分发器使用 PowerShell 5.1 兼容的 UTF-8 stdin 转发', () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/windows-hook-dispatcher.ps1'),
    'utf8',
  )
  assert.doesNotMatch(source, /\$startInfo\.StandardInputEncoding\s*=/)
  assert.match(source, /\[System\.Text\.Encoding\]::UTF8\.GetBytes\(\$rawInput\)/)
  assert.match(source, /StandardInput\.BaseStream\.Write/)
  assert.match(source, /StandardInput\.Close\(\)/)
})

test('源码 CLI 不冒充正式 npm 安装，正式 mjs 与 Desktop 可以登记', () => {
  const source = hookExecutionInternals.distributionContext(
    fixtureModuleUrl('workspace', 'apps', 'cli', 'src', 'index.ts'),
    'C:\\Program Files\\nodejs\\node.exe',
    {},
  )
  assert.equal(source.kind, 'npm')
  assert.equal(source.formalDistribution, false)

  const npm = hookExecutionInternals.distributionContext(
    fixtureModuleUrl('workspace', 'dist', 'cli.mjs'),
    'C:\\Program Files\\nodejs\\node.exe',
    {},
  )
  assert.equal(npm.kind, 'npm')
  assert.equal(npm.formalDistribution, true)

  const desktop = hookExecutionInternals.distributionContext(
    fixtureModuleUrl('resources', 'app.asar.unpacked', 'runtime', 'cli.mjs'),
    'C:\\AgentLens\\AgentLens.exe',
    { AGENT_LENS_DISTRIBUTION: 'desktop' },
  )
  assert.equal(desktop.kind, 'desktop')
  assert.equal(desktop.formalDistribution, true)
  assert.equal(desktop.electronRunAsNode, true)
})
