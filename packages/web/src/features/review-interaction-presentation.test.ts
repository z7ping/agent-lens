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

  assert.equal(entries[0]?.type, 'reasoning')
  if (entries[0]?.type !== 'reasoning') throw new Error('reasoning entry missing')
  assert.deepEqual(entries[0].tools.map(item => item.id), ['tool-child'])
  assert.equal(entries[1]?.type, 'tool-group')
  if (entries[1]?.type !== 'tool-group') throw new Error('tool group missing')
  assert.deepEqual(entries[1].items.map(item => item.id), ['tool-sibling'])
})

test('parentObservationId 也可命中 reasoning 的 observationIds', () => {
  const think = reasoning('think-2')
  const child = tool('tool-child', { observation: 'obs:think-2' })
  const entries = projectReviewInteractionPresentation([think, child])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'reasoning')
  if (entries[0]?.type === 'reasoning') assert.deepEqual(entries[0].tools.map(item => item.id), ['tool-child'])
})

test('只相邻但没有 parent 信息的 Tool 不会被猜成 Thinking 子级', () => {
  const think = reasoning('think-3')
  const adjacent = tool('tool-adjacent')
  const entries = projectReviewInteractionPresentation([think, adjacent])
  assert.equal(entries[0]?.type, 'reasoning')
  if (entries[0]?.type === 'reasoning') assert.equal(entries[0].tools.length, 0)
  assert.equal(entries[1]?.type, 'tool-group')
})

test('跨 source 或多重匹配有歧义时保持 Tool 平级', () => {
  const left = reasoning('think-a', 'same-parent')
  const right = { ...reasoning('think-b', 'same-parent'), id: 'think-b' }
  const ambiguous = tool('tool-ambiguous', { native: 'same-parent' })
  const entries = projectReviewInteractionPresentation([left, right, ambiguous])
  assert.equal(entries.at(-1)?.type, 'tool-group')
})

test('parser replay 后同一 SourceRecord 的旧 unknown 不再与 Thinking 重复展示', () => {
  const sourceRecordId = 'record:reasoning-1'
  const legacy = unknownEvent('legacy-unknown', sourceRecordId)
  const think = reasoning('think-replayed', 'native-think', sourceRecordId)
  const entries = projectReviewInteractionPresentation([legacy, think])

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'reasoning')
})

test('无对应 reasoning 的 unknown 仍保留在全部事件视图', () => {
  const entries = projectReviewInteractionPresentation([unknownEvent('unknown-real', 'record:other')])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'raw-event-group')
})
