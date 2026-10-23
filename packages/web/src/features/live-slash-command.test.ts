import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveCommandDto, LiveMessageDto } from '@agent-lens/protocol'
import { resolveLiveSlash } from './live-task-input'

const commands: LiveCommandDto[] = [
  { value: '/model', group: 'builtin', action: 'open-model' },
  { value: '/compact', group: 'builtin', action: 'runtime-action', runtimeActionId: 'pi.runtime.compact' },
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
  assert.equal(resolveLiveSlash(textMessage('/review changes'), commands).kind, 'prompt')
  assert.equal(resolveLiveSlash(textMessage('/skill:audit'), commands).kind, 'prompt')
  assert.equal(resolveLiveSlash(textMessage('please review /model'), commands).kind, 'prompt')
})

test('unsupported TUI-only commands and action arguments cannot become LLM prompts', () => {
  assert.deepEqual(resolveLiveSlash(textMessage('/settings'), commands), { kind: 'blocked', name: '/settings' })
  assert.deepEqual(resolveLiveSlash(textMessage('/compact custom instructions'), commands), { kind: 'blocked', name: '/compact' })
  assert.deepEqual(resolveLiveSlash(textMessage('/model'), []), { kind: 'blocked', name: '/model' })
  assert.equal(resolveLiveSlash({ parts: [
    { type: 'text', text: '/model' },
    { type: 'image', attachmentId: 'image-1' },
  ] }, commands).kind, 'blocked')
})
