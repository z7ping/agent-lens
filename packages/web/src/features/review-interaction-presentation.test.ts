import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReviewEventNodeDto, ReviewMessageNodeDto, ReviewToolNodeDto } from '@agent-lens/protocol'
import { projectReviewInteractionPresentation, projectReviewMessageModelLabels } from './review-interaction-presentation'

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

test('Tool 即使显式指向 reasoning 也保持 process 原始顺序，不被重新挂载', () => {
  const think = reasoning('think-1', 'native-think-1')
  const child = tool('tool-child', { native: 'native-think-1' })
  const sibling = tool('tool-sibling')
  const entries = projectReviewInteractionPresentation([think, child, sibling])

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
  if (entries[0]?.type !== 'process') throw new Error('process entry missing')
  assert.deepEqual(entries[0].items.flatMap(item => item.type === 'tool-group' ? item.items.map(tool => tool.id) : []), ['tool-child', 'tool-sibling'])
})

test('parentObservationId 不改变 Tool 在 process 中的事实位置', () => {
  const think = reasoning('think-2')
  const child = tool('tool-child', { observation: 'obs:think-2' })
  const entries = projectReviewInteractionPresentation([think, child])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
  if (entries[0]?.type === 'process') assert.deepEqual(entries[0].items.flatMap(item => item.type === 'tool-group' ? item.items.map(tool => tool.id) : []), ['tool-child'])
})

test('相邻 Tool 不依赖 parent 猜测，仍按原序进入 process', () => {
  const think = reasoning('think-3')
  const adjacent = tool('tool-adjacent')
  const entries = projectReviewInteractionPresentation([think, adjacent])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
})

test('跨 source 或 parent 歧义不会触发 Tool 重排', () => {
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

test('无对应 reasoning 的 unknown 仍保留为可展开的原始过程事实', () => {
  const entries = projectReviewInteractionPresentation([unknownEvent('unknown-real', 'record:other')])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
  if (entries[0]?.type === 'process') assert.equal(entries[0].items[0]?.type, 'raw-event-group')
})


test('Review 只用真实模型事件或消息载荷标注对应模型回复', () => {
  const modelChanged: ReviewEventNodeDto = {
    type: 'event',
    id: 'model-changed',
    at: '2026-09-01T00:00:00.500Z',
    sourceId: 'codex',
    kind: 'model.changed',
    category: 'model',
    label: '模型已切换',
    payload: { provider: 'openai', model: 'gpt-5.6' },
    evidence: [],
    observationIds: ['obs:model-changed'],
    capturedAt: '2026-09-01T00:00:00.500Z',
  }
  const modelCall: ReviewEventNodeDto = {
    ...modelChanged,
    id: 'model-call',
    at: '2026-09-01T00:00:01.500Z',
    kind: 'model.call',
    label: '模型调用',
    payload: { provider: 'anthropic', modelName: 'claude-sonnet-4.5' },
    nativeEventId: 'native-model-call',
    observationIds: ['obs:model-call'],
    capturedAt: '2026-09-01T00:00:01.500Z',
  }
  const assistantOne: ReviewMessageNodeDto = {
    type: 'message',
    id: 'assistant-one',
    role: 'assistant',
    at: '2026-09-01T00:00:01.000Z',
    sourceId: 'codex',
    text: 'first',
    payload: {},
    evidence: [],
    observationIds: ['obs:assistant-one'],
    capturedAt: '2026-09-01T00:00:01.000Z',
  }
  const assistantTwo: ReviewMessageNodeDto = {
    ...assistantOne,
    id: 'assistant-two',
    at: '2026-09-01T00:00:02.000Z',
    text: 'second',
    nativeParentEventId: 'native-model-call',
    observationIds: ['obs:assistant-two'],
    capturedAt: '2026-09-01T00:00:02.000Z',
  }
  const assistantPayloadModel: ReviewMessageNodeDto = {
    ...assistantTwo,
    id: 'assistant-three',
    at: '2026-09-01T00:00:03.000Z',
    text: 'third',
    payload: { provider: 'google', model: 'gemini-2.5-pro' },
    observationIds: ['obs:assistant-three'],
    capturedAt: '2026-09-01T00:00:03.000Z',
  }

  const labels = projectReviewMessageModelLabels([
    modelChanged,
    assistantOne,
    modelCall,
    assistantTwo,
    assistantPayloadModel,
  ])

  assert.equal(labels.get('assistant-one'), 'openai / gpt-5.6')
  assert.equal(labels.get('assistant-two'), 'anthropic / claude-sonnet-4.5')
  assert.equal(labels.get('assistant-three'), 'google / gemini-2.5-pro')
})

test('Review 无模型事实时不猜测模型', () => {
  const assistant: ReviewMessageNodeDto = {
    type: 'message',
    id: 'assistant-no-model',
    role: 'assistant',
    at: '2026-09-01T00:00:00.000Z',
    sourceId: 'codex',
    text: 'answer',
    payload: {},
    evidence: [],
    observationIds: ['obs:assistant-no-model'],
    capturedAt: '2026-09-01T00:00:00.000Z',
  }

  assert.equal(projectReviewMessageModelLabels([assistant]).has(assistant.id), false)
})


test('Review 不把未建立父子关系的 model.call 猜给下一个 Assistant', () => {
  const changed: ReviewEventNodeDto = {
    type: 'event', id: 'changed', at: '2026-09-01T00:00:00.000Z', sourceId: 'codex',
    kind: 'model.changed', category: 'model', label: '模型已切换',
    payload: { provider: 'openai', model: 'gpt-state' }, evidence: [],
    observationIds: ['obs:changed'], capturedAt: '2026-09-01T00:00:00.000Z',
  }
  const call: ReviewEventNodeDto = {
    ...changed, id: 'call', at: '2026-09-01T00:00:01.000Z', kind: 'model.call', label: '模型调用',
    payload: { provider: 'anthropic', model: 'claude-call' }, observationIds: ['obs:call'],
  }
  const assistant: ReviewMessageNodeDto = {
    type: 'message', id: 'assistant', role: 'assistant', at: '2026-09-01T00:00:02.000Z', sourceId: 'codex',
    text: 'answer', payload: {}, evidence: [], observationIds: ['obs:assistant'],
    capturedAt: '2026-09-01T00:00:02.000Z',
  }

  const labels = projectReviewMessageModelLabels([changed, call, assistant])
  assert.equal(labels.get('assistant'), 'openai / gpt-state')
})

test('Review 处理详情保持 commentary / lifecycle / tool / compaction 的原始顺序', () => {
  const modelEvent: ReviewEventNodeDto = {
    type: 'event', id: 'model-event', at: '2026-09-01T00:00:01.000Z', sourceId: 'codex',
    kind: 'model.changed', category: 'model', label: '模型已切换', payload: { model: 'gpt-5.6' },
    evidence: [], observationIds: ['obs:model-event'], capturedAt: '2026-09-01T00:00:01.000Z',
  }
  const compaction: ReviewEventNodeDto = {
    ...modelEvent, id: 'compact', at: '2026-09-01T00:00:03.000Z',
    kind: 'context.compaction', category: 'context', label: '上下文压缩',
    payload: {}, observationIds: ['obs:compact'],
  }
  const final: ReviewMessageNodeDto = {
    type: 'message', id: 'final', role: 'assistant', at: '2026-09-01T00:00:04.000Z', sourceId: 'codex',
    text: 'done', payload: {}, evidence: [], observationIds: ['obs:final'],
    capturedAt: '2026-09-01T00:00:04.000Z',
  }
  const entries = projectReviewInteractionPresentation([
    message('commentary-order', 'commentary', 'record:order'),
    modelEvent,
    tool('tool-order'),
    compaction,
    final,
  ])

  assert.equal(entries[0]?.type, 'process')
  if (entries[0]?.type !== 'process') throw new Error('process entry missing')
  assert.deepEqual(entries[0].items.map(item => {
    if (item.type === 'message') return item.node.id
    if (item.type === 'event') return item.node.id
    if (item.type === 'tool-group') return item.items.map(tool => tool.id).join(',')
    return item.items.map(event => event.id).join(',')
  }), ['commentary-order', 'model-event', 'tool-order', 'compact'])
  assert.equal(entries[1]?.type, 'message')
  if (entries[1]?.type === 'message') assert.equal(entries[1].node.id, 'final')
})


test('Review 可证明的 Turn terminal 状态位于 process 与 final answer 之间', () => {
  const terminal: ReviewEventNodeDto = {
    type: 'event',
    id: 'terminal',
    at: '2026-09-01T00:00:03.000Z',
    sourceId: 'codex',
    kind: 'session.lifecycle',
    category: 'lifecycle',
    label: '轮次完成',
    payload: { event: 'turn.completed' },
    evidence: [],
    observationIds: ['obs:terminal'],
    capturedAt: '2026-09-01T00:00:03.000Z',
  }
  const final: ReviewMessageNodeDto = {
    type: 'message',
    id: 'terminal-final',
    role: 'assistant',
    at: '2026-09-01T00:00:02.000Z',
    sourceId: 'codex',
    text: 'done',
    payload: {},
    evidence: [],
    observationIds: ['obs:terminal-final'],
    capturedAt: '2026-09-01T00:00:02.000Z',
  }

  const entries = projectReviewInteractionPresentation([
    message('commentary-terminal', 'commentary', 'record:terminal'),
    terminal,
    final,
  ])
  assert.deepEqual(entries.map(entry => entry.type), ['process', 'event', 'message'])
  if (entries[1]?.type === 'event') assert.equal(entries[1].node.id, 'terminal')
  if (entries[2]?.type === 'message') assert.equal(entries[2].node.id, 'terminal-final')
})


test('Review 非终态运行事件也参与最终回复边界', () => {
  const interim: ReviewMessageNodeDto = {
    type: 'message', id: 'assistant-interim', role: 'assistant',
    at: '2026-09-01T00:00:01.000Z', sourceId: 'codex', text: '处理中',
    payload: {}, evidence: [], observationIds: ['obs:assistant-interim'],
    capturedAt: '2026-09-01T00:00:01.000Z',
  }
  const modelEvent: ReviewEventNodeDto = {
    type: 'event', id: 'model-after-interim', at: '2026-09-01T00:00:02.000Z', sourceId: 'codex',
    kind: 'model.changed', category: 'model', label: '模型切换', payload: { model: 'gpt-5.6' },
    evidence: [], observationIds: ['obs:model-after-interim'], capturedAt: '2026-09-01T00:00:02.000Z',
  }
  const final: ReviewMessageNodeDto = {
    ...interim, id: 'assistant-final-after-model', at: '2026-09-01T00:00:03.000Z',
    text: '最终结果', observationIds: ['obs:assistant-final-after-model'],
    capturedAt: '2026-09-01T00:00:03.000Z',
  }
  const entries = projectReviewInteractionPresentation([interim, modelEvent, final])
  assert.equal(entries[0]?.type, 'process')
  if (entries[0]?.type === 'process') {
    assert.deepEqual(entries[0].items.map(item => item.type === 'message' ? item.node.id : item.type === 'event' ? item.node.id : 'group'), [
      'assistant-interim',
      'model-after-interim',
    ])
  }
  assert.equal(entries[1]?.type, 'message')
  if (entries[1]?.type === 'message') assert.equal(entries[1].node.id, 'assistant-final-after-model')
})
