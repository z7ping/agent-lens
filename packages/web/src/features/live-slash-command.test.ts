import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveCommandDto, LiveMessageDto } from '@agent-lens/protocol'
import { isSlashCommandInput, resolveLiveSlash } from './live-task-input'

const commands: LiveCommandDto[] = [
  { value: '/model', group: 'builtin', action: 'open-model' },
  { value: '/compact', group: 'builtin', action: 'runtime-action', runtimeActionId: 'pi.runtime.compact' },
  { value: '/reload', group: 'builtin', action: 'runtime-action', runtimeActionId: 'pi.runtime.reload' },
  { value: '/review', group: 'extension' },
  { value: '/mcp', group: 'extension', action: 'open-mcp' },
  { value: '/explain', group: 'prompt' },
  { value: '/skill:audit', group: 'skill' },
]

function textMessage(text: string): LiveMessageDto {
  return { parts: [{ type: 'text', text }] }
}

test('UI actions and native extensions execute separately; prompt templates and Skills remain model prompts', () => {
  const model = resolveLiveSlash(textMessage('/model'), commands)
  assert.equal(model.kind, 'action')
  if (model.kind === 'action') assert.equal(model.command.action, 'open-model')
  const compact = resolveLiveSlash(textMessage('/compact'), commands)
  assert.equal(compact.kind, 'action')
  if (compact.kind === 'action') assert.equal(compact.command.runtimeActionId, 'pi.runtime.compact')
  const reload = resolveLiveSlash(textMessage('/reload'), commands)
  assert.equal(reload.kind, 'action')
  if (reload.kind === 'action') assert.equal(reload.command.runtimeActionId, 'pi.runtime.reload')
  assert.equal(resolveLiveSlash(textMessage('/review changes'), commands).kind, 'native-command')
  const mcp = resolveLiveSlash(textMessage('/mcp'), commands)
  assert.equal(mcp.kind, 'action')
  if (mcp.kind === 'action') assert.equal(mcp.command.action, 'open-mcp')
  for (const native of ['/mcp login', '/mcp logout', '/mcp reconnect', '/mcp reconnect docs']) {
    assert.equal(resolveLiveSlash(textMessage(native), commands).kind, 'native-command')
  }
  assert.equal(resolveLiveSlash(textMessage('/mcp list'), commands).kind, 'native-command')
  assert.equal(resolveLiveSlash(textMessage('/skill:audit'), commands).kind, 'prompt')
  assert.equal(resolveLiveSlash(textMessage('/explain'), commands).kind, 'prompt')
  assert.equal(resolveLiveSlash(textMessage('please review /model'), commands).kind, 'prompt')
})

test('unsupported TUI-only commands and action arguments cannot become LLM prompts', () => {
  assert.deepEqual(resolveLiveSlash(textMessage('/settings'), commands), { kind: 'blocked', name: '/settings' })
  assert.deepEqual(resolveLiveSlash(textMessage('/compact custom instructions'), commands), { kind: 'blocked', name: '/compact' })
  assert.deepEqual(resolveLiveSlash(textMessage('/model'), []), { kind: 'blocked', name: '/model' })
  assert.deepEqual(resolveLiveSlash(textMessage('/reload'), []), { kind: 'blocked', name: '/reload' })
  assert.deepEqual(resolveLiveSlash(textMessage('/mcp'), []), { kind: 'blocked', name: '/mcp' })
  assert.deepEqual(resolveLiveSlash(textMessage('/mcp'), commands.filter(item => item.value !== '/mcp')), { kind: 'blocked', name: '/mcp' })
  assert.deepEqual(resolveLiveSlash(textMessage('/future-extension'), commands), { kind: 'blocked', name: '/future-extension' })
  assert.equal(resolveLiveSlash(textMessage('请查看 /mcp 的用法'), commands).kind, 'prompt')
  assert.deepEqual(resolveLiveSlash({ parts: [
    { type: 'text', text: '/mcp' },
    { type: 'image', attachmentId: 'image-1' },
  ] }, commands), { kind: 'blocked', name: '/mcp' })
  assert.deepEqual(resolveLiveSlash(textMessage('/reload now'), commands), { kind: 'blocked', name: '/reload' })
  assert.equal(resolveLiveSlash({ parts: [
    { type: 'text', text: '/model' },
    { type: 'image', attachmentId: 'image-1' },
  ] }, commands).kind, 'blocked')
})

test('Review must not resume a historical session to send slash commands as ordinary messages', () => {
  assert.equal(isSlashCommandInput(textMessage('/reload')), true)
  assert.equal(isSlashCommandInput(textMessage('  /model')), true)
  assert.equal(isSlashCommandInput(textMessage('please /reload')), false)
})

test('a native name collision cannot replace a Web action or reach the model', () => {
  const conflicting: LiveCommandDto[] = [
    { value: '/model', group: 'extension' },
    ...commands,
  ]
  const model = resolveLiveSlash(textMessage('/model'), conflicting)
  assert.equal(model.kind, 'action')
  if (model.kind === 'action') assert.equal(model.command.action, 'open-model')
})
