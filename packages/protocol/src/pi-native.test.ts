import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePiSessionEntry } from './pi-native'

test('Pi Native Normalizer preserves assistant content block order, ids, indexes and terminal facts', () => {
  const facts = normalizePiSessionEntry({
    type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-08-31T00:00:00.000Z',
    message: {
      role: 'assistant', provider: 'openai', model: 'gpt-test', stopReason: 'toolUse',
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { total: 0.012 } },
      content: [
        { type: 'thinking', thinking: '先检查' },
        { type: 'text', text: '开始处理' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'git status' } },
        { type: 'text', text: '工具完成后继续' },
        { type: 'thinking', thinking: '再确认' },
        { type: 'image', mimeType: 'image/png', data: 'safe-placeholder' },
      ],
    },
  })

  assert.deepEqual(facts.map(fact => fact.kind), [
    'thinking',
    'message',
    'tool-call',
    'message',
    'thinking',
    'message',
    'event',
    'usage',
  ])
  assert.deepEqual(facts.slice(0, 6).map(fact => fact.id), [
    'a1',
    'a1:content:1',
    'a1:content:2:tool:c1',
    'a1:content:3',
    'a1:content:4',
    'a1:content:5',
  ])
  assert.deepEqual(facts.slice(0, 6).map(fact => fact.contentIndex), [0, 1, 2, 3, 4, 5])
  assert.equal(facts[0]?.parentId, 'u1')
  assert.ok(facts.slice(1, 6).every(fact => fact.parentId === 'a1'))

  const firstText = facts[1]
  assert.ok(firstText?.kind === 'message')
  assert.equal(firstText.role, 'assistant')
  assert.equal(firstText.text, '开始处理')
  assert.equal(firstText.provider, 'openai')
  assert.equal(firstText.model, 'gpt-test')

  const tool = facts[2]
  assert.ok(tool?.kind === 'tool-call')
  assert.equal(tool.callId, 'c1')
  assert.deepEqual(tool.input, { command: 'git status' })

  const nonText = facts[5]
  assert.ok(nonText?.kind === 'message')
  assert.equal(nonText.text, '')
  assert.equal(nonText.nonTextContent.length, 1)

  const stop = facts[6]
  assert.ok(stop?.kind === 'event')
  assert.equal(stop.event, 'assistant.stop')
  assert.equal(stop.parentId, 'a1')

  const usage = facts[7]
  assert.ok(usage?.kind === 'usage')
  assert.equal(usage.parentId, 'a1')
  assert.equal(usage.usage.totalTokens, 20)
  assert.equal(usage.usage.cost?.total, 0.012)
})

test('Pi Native Normalizer gives scalar assistant content the same block identity contract', () => {
  const facts = normalizePiSessionEntry({
    type: 'message', id: 'a-scalar', parentId: 'u1',
    message: { role: 'assistant', content: '直接正文' },
  })

  assert.equal(facts.length, 1)
  const message = facts[0]
  assert.ok(message?.kind === 'message')
  assert.equal(message.id, 'a-scalar')
  assert.equal(message.parentId, 'u1')
  assert.equal(message.contentIndex, 0)
})

test('Pi Native Normalizer keeps abort lifecycle after content without turning it into an error', () => {
  const facts = normalizePiSessionEntry({
    type: 'message', id: 'a-abort',
    message: {
      role: 'assistant',
      stopReason: 'aborted',
      errorMessage: 'Request aborted',
      content: [
        { type: 'thinking', thinking: '处理中' },
        { type: 'text', text: '部分输出' },
      ],
    },
  })

  assert.deepEqual(facts.map(fact => fact.kind), ['thinking', 'message', 'event'])
  const lifecycle = facts.at(-1)
  assert.ok(lifecycle?.kind === 'event')
  assert.equal(lifecycle.event, 'assistant.cancelled')
  assert.equal(lifecycle.label, '用户已取消 Pi 响应')
  assert.equal(lifecycle.detail, '')
})

test('Pi Native Normalizer preserves a tool call when Pi provides no call id', () => {
  const facts = normalizePiSessionEntry({
    type: 'message', id: 'a-no-call-id', parentId: 'u1',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', name: 'bash', arguments: { command: 'pwd' } }],
    },
  })

  assert.equal(facts.length, 1)
  const tool = facts[0]
  assert.ok(tool?.kind === 'tool-call')
  assert.equal(tool.id, 'a-no-call-id')
  assert.equal(tool.callId, undefined)
  assert.equal(tool.name, 'bash')
  assert.deepEqual(tool.input, { command: 'pwd' })
})

test('Pi Native Normalizer preserves a tool result without inventing a call id', () => {
  const facts = normalizePiSessionEntry({
    type: 'message', id: 'result-no-call-id', parentId: 'a1',
    message: {
      role: 'toolResult',
      toolName: 'bash',
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    },
  })

  assert.equal(facts.length, 1)
  const result = facts[0]
  assert.ok(result?.kind === 'tool-result')
  assert.equal(result.id, 'result-no-call-id')
  assert.equal(result.callId, undefined)
  assert.equal(result.name, 'bash')
  assert.equal(result.output, 'ok')
})

test('Pi Native Normalizer keeps custom and unknown entries visible', () => {
  const custom = normalizePiSessionEntry({ type: 'custom', id: 'x1', customType: 'extension', data: { value: 1 } })
  assert.equal(custom[0]?.kind, 'event')
  const unknown = normalizePiSessionEntry({ type: 'future_entry', id: 'x2', future: { enabled: true } })
  assert.equal(unknown[0]?.kind, 'unknown')
})
