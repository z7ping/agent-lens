import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReviewEventNodeDto, ReviewMessageNodeDto, ReviewToolNodeDto } from '@agent-lens/protocol'
import { projectReviewInteractionPresentation } from './review-interaction-presentation'

function reasoning(id: string, nativeEventId = id, sourceRecordId?: string): ReviewMessageNodeDto {
  return {
    type: 'message', id, role: 'reasoning', at: '2026-09-01T00:00:00.000Z', sourceId: 'codex', text: 'thinking', payload: {},
    evidence: sourceRecordId ? [{ id: `ev:${id}`, captureMethod: 'native-log', derivation: 'reported', confidence: 'high', capturedAt: '2026-09-01T00:00:00.000Z', sourceRecordId }] : [],
    observationIds: [`obs:${id}`], nativeEventId, capturedAt: '2026-09-01T00:00:00.000Z',
  }
}

function message(id: string, role: 'assistant' | 'commentary', sourceRecordId: string): ReviewMessageNodeDto {
  return {
    type: 'message', id, role, at: '2026-09-01T00:00:00.000Z', sourceId: 'codex', text: 'visible process', payload: {},
    evidence: [{ id: `ev:${id}`, captureMethod: 'native-log', derivation: 'reported', confidence: 'high', capturedAt: '2026-09-01T00:00:00.000Z', sourceRecordId }],
    observationIds: [`obs:${id}`], capturedAt: '2026-09-01T00:00:00.000Z',
  }
}

function tool(id: string, parent?: { native?: string; observation?: string }): ReviewToolNodeDto {
  return {
    type: 'tool', id, at: '2026-09-01T00:00:01.000Z', sourceId: 'codex', name: 'read_file', status: 'success', startedAt: '2026-09-01T00:00:01.000Z',
    payload: {}, evidence: [], observationIds: [`obs:${id}`], capturedAt: '2026-09-01T00:00:01.000Z',
    ...(parent?.native ? { nativeParentEventId: parent.native } : {}),
    ...(parent?.observation ? { parentObservationId: parent.observation } : {}),
  }
}

function unknownEvent(id: string, sourceRecordId: string): ReviewEventNodeDto {
  return {
    type: 'event', id, at: '2026-09-01T00:00:00.000Z', sourceId: 'codex', label: '未知事件', category: 'unknown', payload: {},
    evidence: [{ id: `ev:${id}`, captureMethod: 'native-log', derivation: 'reported', confidence: 'high', capturedAt: '2026-09-01T00:00:00.000Z', sourceRecordId }],
    observationIds: [`obs:${id}`], capturedAt: '2026-09-01T00:00:00.000Z', kind: 'unknown',
  } as ReviewEventNodeDto
}

test('Tool 只有显式指向 reasoning 时才进入 Thinking 子级', () => {
  const think = reasoning('think-1', 'native-think-1')
  const child = tool('tool-child', { native: 'native-think-1' })
  const sibling = tool('tool-sibling')
  const entries = projectReviewInteractionPresentation([think, child, sibling])

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
  if (entries[0]?.type !== 'process') throw new Error('process entry missing')
  assert.deepEqual(entries[0].items.flatMap(item => item.type === 'tool-group' ? item.items.map(tool => tool.id) : []), ['tool-child', 'tool-sibling'])
})

test('parentObservationId 也可命中 reasoning 的 observationIds', () => {
  const think = reasoning('think-2')
  const child = tool('tool-child', { observation: 'obs:think-2' })
  const entries = projectReviewInteractionPresentation([think, child])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
  if (entries[0]?.type === 'process') assert.deepEqual(entries[0].items.flatMap(item => item.type === 'tool-group' ? item.items.map(tool => tool.id) : []), ['tool-child'])
})

test('只相邻但没有 parent 信息的 Tool 不会被猜成 Thinking 子级', () => {
  const think = reasoning('think-3')
  const adjacent = tool('tool-adjacent')
  const entries = projectReviewInteractionPresentation([think, adjacent])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
})

test('跨 source 或多重匹配有歧义时保持 Tool 平级', () => {
  const left = reasoning('think-a', 'same-parent')
  const right = { ...reasoning('think-b', 'same-parent'), id: 'think-b' }
  const ambiguous = tool('tool-ambiguous', { native: 'same-parent' })
  const entries = projectReviewInteractionPresentation([left, right, ambiguous])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
})

test('parser replay 后同一 SourceRecord 的旧 unknown 不再与 Thinking 重复展示', () => {
  const sourceRecordId = 'record:reasoning-1'
  const legacy = unknownEvent('legacy-unknown', sourceRecordId)
  const think = reasoning('think-replayed', 'native-think', sourceRecordId)
  const entries = projectReviewInteractionPresentation([legacy, think])

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
})

test('同一 SourceRecord 的旧 assistant 与新 commentary 只展示一次并进入思考过程', () => {
  const sourceRecordId = 'record:commentary-1'
  const entries = projectReviewInteractionPresentation([
    message('legacy-assistant', 'assistant', sourceRecordId),
    message('canonical-commentary', 'commentary', sourceRecordId),
    tool('tool-after-commentary'),
  ])

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
  if (entries[0]?.type !== 'process') throw new Error('process entry missing')
  assert.deepEqual(entries[0].items.map(item => item.type), ['message', 'tool-group'])
  if (entries[0].items[0]?.type === 'message') assert.equal(entries[0].items[0].node.id, 'canonical-commentary')
})

test('Usage 等观测事件不会把同一轮思考过程切成多个父块', () => {
  const usage: ReviewEventNodeDto = {
    type: 'event', id: 'usage-1', at: '2026-09-01T00:00:02.000Z', sourceId: 'codex', label: '用量', category: 'usage', kind: 'usage', payload: {},
    evidence: [], observationIds: ['obs:usage-1'], capturedAt: '2026-09-01T00:00:02.000Z',
  }
  const entries = projectReviewInteractionPresentation([
    message('commentary-1', 'commentary', 'record:commentary-1'),
    tool('tool-1'),
    usage,
    message('commentary-2', 'commentary', 'record:commentary-2'),
    tool('tool-2'),
  ])

  assert.equal(entries.filter(entry => entry.type === 'process').length, 1)
  const process = entries.find(entry => entry.type === 'process')
  if (process?.type !== 'process') throw new Error('process entry missing')
  assert.deepEqual(process.items.flatMap(item => item.type === 'tool-group' ? item.items.map(tool => tool.id) : []), ['tool-1', 'tool-2'])
})

test('无对应 reasoning 的 unknown 仍保留在全部事件视图', () => {
  const entries = projectReviewInteractionPresentation([unknownEvent('unknown-real', 'record:other')])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'raw-event-group')
})
