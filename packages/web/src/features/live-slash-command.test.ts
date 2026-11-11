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
  assert.equal(mcp.kind, 'native-command')
  if (mcp.kind === 'native-command') assert.equal(mcp.command.action, 'open-mcp')
  for (const native of ['/mcp login', '/mcp logout', '/mcp reconnect', '/mcp reconnect docs']) {
    assert.equal(resolveLiveSlash(textMessage(native), commands).kind, 'native-command')
  }
  assert.equal(resolveLiveSlash(textMessage('/mcp list'), commands).kind, 'native-command')
  assert.equal(resolveLiveSlash(textMessage('/skill:audit'), commands).kind, 'prompt')
  assert.equal(resolveLiveSlash(textMessage('/explain'), commands).kind, 'prompt')
  assert.equal(resolveLiveSlash(textMessage('please review /model'), commands).kind, 'prompt')
})

test('unregistered slash text, API routes and file paths are normal native prompts', () => {
  for (const input of [
    '/appletMenuManagement/applet，需要增加菜单编码 menu_code 字段',
    '/appletMenuManagement/applet',
    '/api/v1/sessions',
    '/tmp/example.ts',
    '/future-extension',
    '/settings',
    '/unknown with arguments',
    '/model/path',
  ]) {
    assert.equal(resolveLiveSlash(textMessage(input), commands).kind, 'prompt', input)
  }
  assert.deepEqual(resolveLiveSlash(textMessage('/model'), []), { kind: 'prompt' })
  assert.deepEqual(resolveLiveSlash(textMessage('/reload'), []), { kind: 'prompt' })
  assert.deepEqual(resolveLiveSlash(textMessage('/mcp'), []), { kind: 'prompt' })
  assert.deepEqual(resolveLiveSlash(
    textMessage('/mcp'), commands.filter(item => item.value !== '/mcp'),
  ), { kind: 'prompt' })
})

test('registered UI commands reject unsupported arguments and attachments', () => {
  assert.deepEqual(resolveLiveSlash(textMessage('/compact custom instructions'), commands), { kind: 'blocked', name: '/compact' })
  assert.deepEqual(resolveLiveSlash(textMessage('/reload now'), commands), { kind: 'blocked', name: '/reload' })
  assert.deepEqual(resolveLiveSlash({ parts: [
    { type: 'text', text: '/mcp' },
    { type: 'image', attachmentId: 'image-1' },
  ] }, commands), { kind: 'blocked', name: '/mcp' })
  assert.equal(resolveLiveSlash({ parts: [
    { type: 'text', text: '/model' },
    { type: 'image', attachmentId: 'image-1' },
  ] }, commands).kind, 'blocked')
})

test('Review recognizes only Runtime-declared slash commands, never arbitrary slash text', () => {
  assert.equal(isSlashCommandInput(textMessage('/reload'), commands), true)
  assert.equal(isSlashCommandInput(textMessage('  /model'), commands), true)
  assert.equal(isSlashCommandInput(textMessage('/mcp login docs'), commands), true)
  assert.equal(isSlashCommandInput(textMessage('/skill:audit'), commands), false)
  assert.equal(isSlashCommandInput(textMessage('/appletMenuManagement/applet'), commands), false)
  assert.equal(isSlashCommandInput(textMessage('/settings'), commands), false)
  assert.equal(isSlashCommandInput(textMessage('/reload'), []), false)
  assert.equal(isSlashCommandInput(textMessage('please /reload'), commands), false)
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
