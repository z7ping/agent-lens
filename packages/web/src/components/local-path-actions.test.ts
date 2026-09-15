import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./LocalPathActions.tsx', import.meta.url), 'utf8')

test('本地路径操作会回显宿主打开结果，并在宿主不支持时禁用打开动作', () => {
  assert.match(source, /hostOpenAction\(result\) \?\? 'opened'/)
  assert.match(source, /error instanceof AgentLensRequestError && error\.status === 501/)
  assert.match(source, /disabled=\{opening \|\| unsupported\}/)
  assert.match(source, /t\('localPath\.opened'\)/)
  assert.match(source, /t\('localPath\.revealed'\)/)
  assert.match(source, /t\('localPath\.unsupported'\)/)
})
