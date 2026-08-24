import assert from 'node:assert/strict'
import test from 'node:test'
import { windowsDispatcherCommand } from './hook-execution'

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
