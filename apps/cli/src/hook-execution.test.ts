import assert from 'node:assert/strict'
import test from 'node:test'
import { windowsHookCommand } from './hook-execution'

test('Windows Hook 命令通过隐藏 PowerShell 调起 Node Hook', () => {
  const command = windowsHookCommand(
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Agent Lens\\dist\\hooks\\agent-lens-hook-runner.ps1',
    'C:\\Agent Lens\\dist\\hooks\\agent-lens-hook-codex.mjs',
  )

  assert.match(command, /^powershell\.exe /)
  assert.match(command, /-WindowStyle Hidden/)
  assert.match(command, /-ExecutionPolicy Bypass/)
  assert.match(command, /agent-lens-hook-runner\.ps1/)
  assert.match(command, /agent-lens-hook-codex\.mjs/)
  assert.match(command, /"C:\\Program Files\\nodejs\\node\.exe"/)
})
