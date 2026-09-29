import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewToolCommand } from './review-tool-command'

test('Codex command_execution 优先展示已解析命令，不暴露转义后的命令数组', () => {
  assert.equal(reviewToolCommand({
    command: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-Command', 'rg -n "needle" packages'],
    parsedCommand: [{ type: 'unknown', cmd: 'rg -n "needle" packages' }],
  }), 'rg -n "needle" packages')
})

test('Pi Bash 和普通 Shell 输入保留原始命令', () => {
  assert.equal(reviewToolCommand({ command: 'npm test' }), 'npm test')
  assert.equal(reviewToolCommand('git status'), 'git status')
})
