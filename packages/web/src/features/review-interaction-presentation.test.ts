import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReviewEventNodeDto, ReviewMessageNodeDto, ReviewToolNodeDto } from '@agent-lens/protocol'
import { projectReviewInteractionPresentation, projectReviewInteractionToolStats, projectReviewMessageModelLabels } from './review-interaction-presentation'

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

test('Tool 显式指向 reasoning 时标记归属、保持原序且不连带相邻无归属工具', () => {
  const think = reasoning('think-1', 'native-think-1')
  const child = tool('tool-child', { native: 'native-think-1' })
  const sibling = tool('tool-sibling')
  const entries = projectReviewInteractionPresentation([think, child, sibling])

  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
  if (entries[0]?.type !== 'process') throw new Error('process entry missing')
  const groups = entries[0].items.filter(item => item.type === 'tool-group')
  assert.deepEqual(groups.flatMap(item => item.items.map(tool => tool.id)), ['tool-child', 'tool-sibling'])
  assert.equal(groups[0]?.parentReasoningId, 'think-1')
  assert.equal(groups[1]?.parentReasoningId, undefined)
})

test('parentObservationId 不改变 Tool 在 process 中的事实位置', () => {
  const think = reasoning('think-2')
  const child = tool('tool-child', { observation: 'obs:think-2' })
  const entries = projectReviewInteractionPresentation([think, child])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
  if (entries[0]?.type === 'process') {
    const groups = entries[0].items.filter(item => item.type === 'tool-group')
    assert.deepEqual(groups.flatMap(item => item.items.map(tool => tool.id)), ['tool-child'])
    assert.equal(groups[0]?.parentReasoningId, 'think-2')
  }
})

test('相邻 Tool 不依赖 parent 猜测，仍按原序进入 process', () => {
  const think = reasoning('think-3')
  const adjacent = tool('tool-adjacent')
  const entries = projectReviewInteractionPresentation([think, adjacent])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
  if (entries[0]?.type === 'process') {
    const groups = entries[0].items.filter(item => item.type === 'tool-group')
    assert.equal(groups[0]?.parentReasoningId, undefined)
  }
})

test('跨 source 或 parent 歧义不会触发 Tool 重排', () => {
  const left = reasoning('think-a', 'same-parent')
  const right = { ...reasoning('think-b', 'same-parent'), id: 'think-b' }
  const ambiguous = tool('tool-ambiguous', { native: 'same-parent' })
  const entries = projectReviewInteractionPresentation([left, right, ambiguous])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'process')
  if (entries[0]?.type === 'process') {
    const groups = entries[0].items.filter(item => item.type === 'tool-group')
    assert.equal(groups[0]?.parentReasoningId, undefined)
  }
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

test('Usage 等元事件位于 Process 外，同时 Process 仍保持单一父块', () => {
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
  assert.equal(process.items.some(item => item.type === 'event' && item.node.id === 'usage-1'), false)
  const usageEntry = entries.find(entry => entry.type === 'event' && entry.node.id === 'usage-1')
  assert.ok(usageEntry)
})

test('无对应 reasoning 的 unknown 保留在 Process 外的原始事件区', () => {
  const entries = projectReviewInteractionPresentation([unknownEvent('unknown-real', 'record:other')])
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.type, 'raw-event-group')
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

test('Review 处理详情只收模型执行，model / context 元事件独立展示', () => {
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
    if (item.type === 'tool-group') return item.items.map(tool => tool.id).join(',')
    return 'unexpected'
  }), ['commentary-order', 'tool-order'])
  assert.equal(entries[1]?.type, 'event')
  if (entries[1]?.type === 'event') assert.equal(entries[1].node.id, 'model-event')
  assert.equal(entries[2]?.type, 'event')
  if (entries[2]?.type === 'event') assert.equal(entries[2].node.id, 'compact')
  assert.equal(entries[3]?.type, 'message')
  if (entries[3]?.type === 'message') assert.equal(entries[3].node.id, 'final')
})


test('Review Assistant 正文即使后面还有 Tool / Reasoning 也不进入处理详情', () => {
  const assistant: ReviewMessageNodeDto = {
    type: 'message', id: 'assistant-before-process', role: 'assistant',
    at: '2026-09-01T00:00:01.000Z', sourceId: 'claude', text: '先给出正文',
    payload: {}, evidence: [], observationIds: ['obs:assistant-before-process'],
    capturedAt: '2026-09-01T00:00:01.000Z',
  }
  const laterReasoning: ReviewMessageNodeDto = {
    ...assistant, id: 'reasoning-after-assistant', role: 'reasoning',
    at: '2026-09-01T00:00:03.000Z', text: '迟到的思考',
    observationIds: ['obs:reasoning-after-assistant'],
    capturedAt: '2026-09-01T00:00:03.000Z',
  }
  const entries = projectReviewInteractionPresentation([
    assistant,
    tool('tool-after-assistant'),
    laterReasoning,
  ])
  const process = entries.find(entry => entry.type === 'process')
  assert.ok(process)
  if (process?.type === 'process') {
    assert.equal(process.items.some(item => item.type === 'message' && item.node.id === 'assistant-before-process'), false)
  }
  const mainText = entries.find(entry => entry.type === 'message' && entry.node.id === 'assistant-before-process')
  assert.ok(mainText)
})


test('Review 按原生 assistant.stop + stopReason 跳过无意义结束记录，不依赖 Agent ID', () => {
  const legacy = (id: string, stopReason: string): ReviewEventNodeDto => ({
    type: 'event',
    id,
    at: '2026-09-01T00:00:01.000Z',
    sourceId: 'pi',
    kind: 'session.lifecycle',
    category: 'lifecycle',
    label: 'Pi 响应结束',
    payload: { event: 'assistant.stop', stopReason },
    evidence: [],
    observationIds: [`obs:${id}`],
    capturedAt: '2026-09-01T00:00:01.000Z',
  })

  const truncated = legacy('legacy-length', 'length')
  const entries = projectReviewInteractionPresentation([
    legacy('legacy-stop', 'stop'),
    legacy('legacy-tool-use', 'toolUse'),
    { ...legacy('cross-agent-stop', 'stop'), sourceId: 'hermes' },
    truncated,
  ])

  assert.equal(entries.some(entry => entry.type === 'event' && entry.node.id === 'legacy-stop'), false)
  assert.equal(entries.some(entry => entry.type === 'event' && entry.node.id === 'legacy-tool-use'), false)
  assert.equal(entries.some(entry => entry.type === 'event' && entry.node.id === 'legacy-length'), true)
  assert.equal(entries.some(entry => entry.type === 'event' && entry.node.id === 'cross-agent-stop'), false)
})

test('Review 可证明的 Turn terminal 状态位于 final answer 之后', () => {
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
  assert.deepEqual(entries.map(entry => entry.type), ['process', 'message', 'event'])
  if (entries[1]?.type === 'message') assert.equal(entries[1].node.id, 'terminal-final')
  if (entries[2]?.type === 'event') assert.equal(entries[2].node.id, 'terminal')
})


test('Review 非终态元事件不参与最终回复边界', () => {
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
  assert.equal(entries.some(entry => entry.type === 'process'), false)
  assert.deepEqual(entries.map(entry => entry.type === 'message' || entry.type === 'event' ? entry.node.id : entry.type), [
    'assistant-interim',
    'model-after-interim',
    'assistant-final-after-model',
  ])
})


test('Review summary-mode 外层轮次统计复用 Process Summary，而不是被裁掉的 Tool 节点', () => {
  const stats = projectReviewInteractionToolStats({
    nodes: [],
    processSummary: {
      id: 'process:round-summary',
      revision: 'r1',
      itemCount: 12,
      messageCount: 4,
      toolCount: 7,
      errorCount: 2,
      durationMs: 9_000,
      availability: 'available',
      totalFactCount: 12,
    },
  })
  assert.deepEqual(stats, { toolCount: 7, errorCount: 2 })
})

test('Review full-mode 没有 Process Summary 时仍从 Tool 节点统计', () => {
  const failed = { ...tool('tool-failed'), status: 'error' as const }
  const stats = projectReviewInteractionToolStats({ nodes: [tool('tool-ok'), failed] })
  assert.deepEqual(stats, { toolCount: 2, errorCount: 1 })
})


test('Review Tool progress 仍属于 Process，不被元事件边界挪出去', () => {
  const progress: ReviewEventNodeDto = {
    type: 'event',
    id: 'tool-progress',
    at: '2026-09-01T00:00:01.500Z',
    sourceId: 'codex',
    kind: 'tool.progress',
    category: 'unknown',
    label: '工具进度',
    payload: {},
    evidence: [],
    observationIds: ['obs:tool-progress'],
    capturedAt: '2026-09-01T00:00:01.500Z',
  }
  const final: ReviewMessageNodeDto = {
    type: 'message',
    id: 'tool-progress-final',
    role: 'assistant',
    at: '2026-09-01T00:00:02.000Z',
    sourceId: 'codex',
    text: '完成',
    payload: {},
    evidence: [],
    observationIds: ['obs:tool-progress-final'],
    capturedAt: '2026-09-01T00:00:02.000Z',
  }
  const entries = projectReviewInteractionPresentation([progress, final])
  assert.equal(entries[0]?.type, 'process')
  if (entries[0]?.type === 'process') {
    assert.equal(entries[0].items[0]?.type, 'event')
    if (entries[0].items[0]?.type === 'event') assert.equal(entries[0].items[0].node.id, 'tool-progress')
  }
  assert.equal(entries[1]?.type, 'message')
})

// 这些输入是由 Source Adapter 已知原生映射构造的 Canonical 形状；不是实机录制结果。
test('Pi/Codex 的原生处理中间消息和 Tool 进入同一 Process；未知事件仍可诊断', () => {
  for (const [sourceId, role] of [['pi', 'commentary'], ['codex', 'reasoning']] as const) {
    const interim: ReviewMessageNodeDto = {
      type: 'message', id: sourceId + ':interim', role,
      at: '2026-09-01T00:00:01.000Z', sourceId,
      text: '检查中', payload: {}, evidence: [], observationIds: ['obs:interim'],
      capturedAt: '2026-09-01T00:00:01.000Z',
    }
    const call = { ...tool(sourceId + ':call'), sourceId }
    const result: ReviewMessageNodeDto = {
      ...interim, id: sourceId + ':final', role: 'assistant',
      at: '2026-09-01T00:00:03.000Z', text: '处理完毕', observationIds: ['obs:final'],
    }
    const raw: ReviewEventNodeDto = {
      ...unknownEvent(sourceId + ':raw', sourceId + ':raw-record'), sourceId,
      payload: { nativeType: 'unrecognized-future-event' },
    }
    const entries = projectReviewInteractionPresentation([interim, call, result, raw])
    assert.equal(entries[0]?.type, 'process', sourceId)
    if (entries[0]?.type !== 'process') throw new Error(sourceId + ': process missing')
    assert.deepEqual(entries[0].items.map(item => item.type), ['message', 'tool-group'])
    assert.equal(entries[1]?.type, 'message', sourceId)
    assert.equal(entries[2]?.type, 'raw-event-group', sourceId)
    if (entries[2]?.type === 'raw-event-group') assert.equal(entries[2].items[0]?.id, raw.id)
  }
})

test('Claude Code 不能把普通 assistant 文本仅凭 Tool 相邻关系归入思考', () => {
  const intermediate: ReviewMessageNodeDto = {
    type: 'message', id: 'claude:intermediate', role: 'assistant',
    at: '2026-09-01T00:00:01.000Z', sourceId: 'claude-code', text: '正在检查',
    payload: {}, evidence: [], observationIds: ['obs:claude-intermediate'],
    capturedAt: '2026-09-01T00:00:01.000Z',
  }
  const result = { ...intermediate, id: 'claude:final', text: '检查完成', observationIds: ['obs:claude-final'] }
  const entries = projectReviewInteractionPresentation([intermediate, { ...tool('claude:tool'), sourceId: 'claude-code' }, result])
  const process = entries.find(entry => entry.type === 'process')
  assert.ok(process?.type === 'process')
  assert.equal(process.items.filter(item => item.type === 'tool-group').length, 1)
  assert.deepEqual(entries.filter(entry => entry.type === 'message').map(entry => entry.type === 'message' ? entry.node.id : ''), ['claude:intermediate', 'claude:final'])
})

test('正常生命周期元事件默认合并，失败事件保留单独显示且不丢失原文', () => {
  const life = (action: string, time: string, status = ''): ReviewEventNodeDto => ({
    type: 'event', id: action, at: time, capturedAt: time, sourceId: 'codex',
    kind: 'session.lifecycle', category: 'lifecycle', label: action,
    payload: { event: action, ...(status ? { status } : {}) },
    evidence: [], observationIds: [`obs:${action}`],
  })
  const entries = projectReviewInteractionPresentation([
    life('thread.settings.applied', '2026-10-16T21:11:28Z'),
    life('turn.started', '2026-10-16T21:11:29Z'),
    life('turn.context', '2026-10-16T21:11:30Z'),
    life('turn.error', '2026-10-16T21:11:31Z'),
  ])
  assert.deepEqual(entries.map(entry => entry.type), ['runtime-event-group', 'event'])
  if (entries[0]?.type === 'runtime-event-group') {
    assert.deepEqual(entries[0].items.map(item => item.id),
      ['thread.settings.applied', 'turn.started', 'turn.context'])
  }
  if (entries[1]?.type === 'event') assert.equal(entries[1].node.id, 'turn.error')
  const failed = projectReviewInteractionPresentation([life('turn.context', '2026-10-16T21:11:32Z', 'failed')])
  assert.equal(failed[0]?.type, 'event')
})

test('旧轮次完成时间早于新轮次开始时不再被强制后移；合法终态仍在最终回答后', () => {
  const life = (action: string, time: string): ReviewEventNodeDto => ({
    type: 'event', id: action, at: time, capturedAt: time, sourceId: 'codex',
    kind: 'session.lifecycle', category: 'lifecycle', label: action,
    payload: { event: action }, evidence: [], observationIds: [`obs:${action}`],
  })
  const entries = projectReviewInteractionPresentation([
    life('turn.completed', '2026-10-16T21:09:22Z'),
    life('turn.started', '2026-10-16T21:11:29Z'),
  ])
  assert.deepEqual(entries.map(entry => entry.type), ['event', 'runtime-event-group'])
  if (entries[0]?.type === 'event') assert.equal(entries[0].node.id, 'turn.completed')
  const late = projectReviewInteractionPresentation([
    life('turn.started', '2026-10-16T21:11:29Z'),
    life('turn.completed', '2026-10-16T21:11:32Z'),
  ])
  assert.deepEqual(late.map(entry => entry.type), ['runtime-event-group', 'event'])
})
