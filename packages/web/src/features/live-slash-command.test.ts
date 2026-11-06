import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveCommandDto, LiveMessageDto } from '@agent-lens/protocol'
import { isSlashCommandInput, resolveLiveSlash } from './live-task-input'

const commands: LiveCommandDto[] = [
  { value: '/model', group: 'builtin', action: 'open-model' },
  { value: '/compact', group: 'builtin', action: 'runtime-action', runtimeActionId: 'pi.runtime.compact' },
  { value: '/reload', group: 'builtin', action: 'runtime-action', runtimeActionId: 'pi.runtime.reload' },
  { value: '/review', group: 'extension' },
  { value: '/skill:audit', group: 'skill' },
]

function textMessage(text: string): LiveMessageDto {
  return { parts: [{ type: 'text', text }] }
}

test('only Runtime-declared Web actions are intercepted; extension and Skill commands stay native', () => {
  const model = resolveLiveSlash(textMessage('/model'), commands)
  assert.equal(model.kind, 'action')
  if (model.kind === 'action') assert.equal(model.command.action, 'open-model')
  const compact = resolveLiveSlash(textMessage('/compact'), commands)
  assert.equal(compact.kind, 'action')
  if (compact.kind === 'action') assert.equal(compact.command.runtimeActionId, 'pi.runtime.compact')
  const reload = resolveLiveSlash(textMessage('/reload'), commands)
  assert.equal(reload.kind, 'action')
  if (reload.kind === 'action') assert.equal(reload.command.runtimeActionId, 'pi.runtime.reload')
  assert.equal(resolveLiveSlash(textMessage('/review changes'), commands).kind, 'prompt')
  assert.equal(resolveLiveSlash(textMessage('/skill:audit'), commands).kind, 'prompt')
  assert.equal(resolveLiveSlash(textMessage('please review /model'), commands).kind, 'prompt')
})

test('unsupported TUI-only commands and action arguments cannot become LLM prompts', () => {
  assert.deepEqual(resolveLiveSlash(textMessage('/settings'), commands), { kind: 'blocked', name: '/settings' })
  assert.deepEqual(resolveLiveSlash(textMessage('/compact custom instructions'), commands), { kind: 'blocked', name: '/compact' })
  assert.deepEqual(resolveLiveSlash(textMessage('/model'), []), { kind: 'blocked', name: '/model' })
  assert.deepEqual(resolveLiveSlash(textMessage('/reload'), []), { kind: 'blocked', name: '/reload' })
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
