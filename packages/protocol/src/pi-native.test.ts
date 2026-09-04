import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePiSessionEntry } from './pi-native'

test('Pi Native Normalizer preserves tree, assistant usage/cost and tool semantics', () => {
  const facts = normalizePiSessionEntry({
    type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-08-31T00:00:00.000Z',
    message: {
      role: 'assistant', provider: 'openai', model: 'gpt-test', stopReason: 'toolUse',
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { total: 0.012 } },
      content: [
        { type: 'thinking', thinking: 'inspect' },
        { type: 'text', text: 'working' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'git status' } },
        { type: 'image', mimeType: 'image/png', data: 'safe-placeholder' },
      ],
    },
  })
  assert.deepEqual(facts.map(fact => fact.kind), ['message', 'thinking', 'tool-call', 'usage'])
  const assistant = facts[0]
  assert.ok(assistant?.kind === 'message')
  assert.equal(assistant.parentId, 'u1')
  assert.equal(assistant.stopReason, 'toolUse')
  assert.equal(assistant.nonTextContent.length, 1)
  const tool = facts.find(fact => fact.kind === 'tool-call')
  assert.ok(tool?.kind === 'tool-call')
  assert.equal(tool.parentId, 'a1')
  assert.equal(tool.callId, 'c1')
  const usage = facts.find(fact => fact.kind === 'usage')
  assert.ok(usage?.kind === 'usage')
  assert.equal(usage.usage.totalTokens, 20)
  assert.equal(usage.usage.cost?.total, 0.012)
})

test('Pi Native Normalizer keeps custom and unknown entries visible', () => {
  const custom = normalizePiSessionEntry({ type: 'custom', id: 'x1', customType: 'extension', data: { value: 1 } })
  assert.equal(custom[0]?.kind, 'event')
  const unknown = normalizePiSessionEntry({ type: 'future_entry', id: 'x2', future: { enabled: true } })
  assert.equal(unknown[0]?.kind, 'unknown')
})
