import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveRuntimeEventDto } from '@agent-lens/protocol'
import {
  appendLiveInputHistory,
  appendOptimisticLiveUserMessage,
  LiveTaskRoundProjector,
  liveEventChangesTaskTranscript,
  liveTaskStableRoundPrefixLength,
  mergeLiveActiveProjectionItems,
  projectLiveInputHistory,
  projectLiveSnapshotEntries,
  projectLiveTaskRounds,
  liveTaskRoundEstimate,
  reduceLiveTaskEvent,
  settleLiveTaskProjectionItems,
} from './live-task-projection'

function event(sequence: number, normalizedEvent: NonNullable<LiveRuntimeEventDto['normalizedEvent']>): LiveRuntimeEventDto {
  return {
    runtimeSessionId: 'runtime-1',
    sequence,
    receivedAt: `2026-09-17T12:00:0${sequence}.000Z`,
    event: {},
    normalizedEvent,
  }
}

test('optimistic projection keeps image-only user messages', () => {
  const items = appendOptimisticLiveUserMessage([], '', 'user:image-only', [{
    type: 'image',
    name: 'shot.png',
    mimeType: 'image/png',
    sizeBytes: 12,
    previewUrl: 'blob:agent-lens-preview',
  }])

  assert.equal(items.length, 1)
  const item = items[0]
  assert.ok(item?.kind === 'message')
  assert.equal(item.text, '')
  assert.equal(item.attachments?.[0]?.previewUrl, 'blob:agent-lens-preview')
})

test('optimistic projection keeps file-only user messages', () => {
  const items = appendOptimisticLiveUserMessage([], '', 'user:file-only', [{
    type: 'file',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 42,
  }])

  assert.equal(items.length, 1)
  const item = items[0]
  assert.ok(item?.kind === 'message')
  assert.equal(item.text, '')
  assert.equal(item.attachments?.[0]?.type, 'file')
  assert.equal(item.attachments?.[0]?.name, 'report.pdf')
})

test('snapshot projection keeps generic inline image attachments', () => {
  const items = projectLiveSnapshotEntries([
    {
      id: 'u-image',
      role: 'user',
      content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
    },
  ])

  assert.equal(items.length, 1)
  const item = items[0]
  assert.ok(item?.kind === 'message')
  assert.equal(item.text, '')
  assert.equal(item.attachments?.[0]?.type, 'image')
  assert.equal(item.attachments?.[0]?.dataUrl, 'data:image/png;base64,aGVsbG8=')
})

test('snapshot projection keeps nested persisted image attachments used by Pi session entries', () => {
  const items = projectLiveSnapshotEntries([
    {
      type: 'message',
      id: 'entry-image-1',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        ],
      },
    },
  ])

  assert.equal(items.length, 1)
  const item = items[0]
  assert.ok(item?.kind === 'message')
  assert.equal(item.entryId, 'entry-image-1')
  assert.equal(item.text, '看这张图')
  assert.equal(item.attachments?.[0]?.type, 'image')
  assert.equal(item.attachments?.[0]?.dataUrl, 'data:image/png;base64,aGVsbG8=')
})

test('snapshot projection keeps nested persisted file attachments', () => {
  const items = projectLiveSnapshotEntries([
    {
      type: 'message',
      id: 'entry-file-1',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '看这个文件' },
          { type: 'file', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 42 },
        ],
      },
    },
  ])

  assert.equal(items.length, 1)
  const item = items[0]
  assert.ok(item?.kind === 'message')
  assert.equal(item.entryId, 'entry-file-1')
  assert.equal(item.text, '看这个文件')
  assert.equal(item.attachments?.[0]?.type, 'file')
  assert.equal(item.attachments?.[0]?.name, 'report.pdf')
})

test('snapshot projection consumes message-shaped native rows without Agent-specific branches', () => {
  assert.deepEqual(projectLiveSnapshotEntries([
    { id: 'u1', role: 'user', content: 'hello' },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'world' }] },
    { event: 'runtime_status', status: 'ready' },
  ]), [
    { id: 'u1', kind: 'message', role: 'user', text: 'hello', streaming: false },
    { id: 'a1', kind: 'message', role: 'assistant', text: 'world', streaming: false },
  ])
})

test('message action targets are exposed only for persisted message entries', () => {
  const items = projectLiveSnapshotEntries([
    {
      type: 'message',
      id: 'entry-user-1',
      parentId: null,
      message: { role: 'user', content: [{ type: 'text', text: 'persisted prompt' }] },
    },
    { id: 'event-user-1', role: 'user', content: 'generic event message' },
  ])

  assert.equal(items[0]?.kind === 'message' ? items[0].entryId : undefined, 'entry-user-1')
  assert.equal(items[1]?.kind === 'message' ? items[1].entryId : undefined, undefined)
})

test('snapshot projection preserves assistant reasoning and tool history across reload', () => {
  const items = projectLiveSnapshotEntries([
    {
      type: 'message',
      id: 'assistant-1',
      timestamp: '2026-09-18T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'inspect first' },
          { type: 'text', text: 'checking' },
          { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'README.md' } },
          { type: 'text', text: 'done' },
        ],
      },
    },
    {
      type: 'message',
      id: 'result-1',
      timestamp: '2026-09-18T00:00:01.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'read',
        isError: false,
        content: [{ type: 'text', text: 'file content' }],
      },
    },
  ])

  assert.deepEqual(items.map(item => item.kind), ['thinking', 'message', 'tool', 'message'])
  assert.equal(items[0]?.kind === 'thinking' ? items[0].text : '', 'inspect first')
  const tool = items.find(item => item.kind === 'tool')
  assert.ok(tool?.kind === 'tool')
  assert.equal(tool.name, 'read')
  assert.equal(tool.status, 'success')
  assert.equal(tool.output, 'file content')
})

test('normalized Live events drive shared message reasoning and tool projections', () => {
  let items = projectLiveSnapshotEntries([])
  items = appendOptimisticLiveUserMessage(items, 'fix it', 'user:1')
  items = reduceLiveTaskEvent(items, event(1, { type: 'text.start', messageId: 'a1', contentIndex: 0 }))
  items = reduceLiveTaskEvent(items, event(2, { type: 'text.delta', messageId: 'a1', contentIndex: 0, delta: 'working' }))
  items = reduceLiveTaskEvent(items, event(3, { type: 'reasoning.delta', contentIndex: 1, delta: 'inspect repo' }))
  items = reduceLiveTaskEvent(items, event(4, { type: 'tool.start', callId: 'tool-1', name: 'read', inputPreview: 'src/index.ts' }))
  items = reduceLiveTaskEvent(items, event(5, { type: 'tool.end', callId: 'tool-1', name: 'read', status: 'success', output: 'ok', durationMs: 12 }))
  items = reduceLiveTaskEvent(items, event(6, { type: 'text.end', messageId: 'a1', contentIndex: 0, text: 'working done' }))

  assert.deepEqual(items, [
    { id: 'user:1', kind: 'message', role: 'user', text: 'fix it', streaming: false },
    { id: 'message:a1:0', kind: 'message', role: 'assistant', text: 'working done', streaming: false, at: '2026-09-17T12:00:01.000Z' },
    { id: 'thinking:content:1', kind: 'thinking', text: 'inspect repo', streaming: false, at: '2026-09-17T12:00:03.000Z' },
    { id: 'tool:tool-1', kind: 'tool', callId: 'tool-1', name: 'read', inputPreview: 'src/index.ts', output: 'ok', status: 'success', durationMs: 12, at: '2026-09-17T12:00:04.000Z' },
  ])
})


test('streaming recovery supplements missing nodes without overwriting newer live state', () => {
  const current = [
    { id: 'user:optimistic', kind: 'message' as const, role: 'user' as const, text: 'same prompt', streaming: false },
    { id: 'message:a1:0', kind: 'message' as const, role: 'assistant' as const, text: 'newer-live', streaming: true },
  ]
  const recovered = [
    { id: 'entry-user-1', kind: 'message' as const, role: 'user' as const, text: 'same prompt', streaming: false },
    { id: 'message:a1:0', kind: 'message' as const, role: 'assistant' as const, text: 'older-snapshot', streaming: true },
    { id: 'tool:1', kind: 'tool' as const, callId: '1', name: 'read', status: 'success' as const },
  ]

  const merged = mergeLiveActiveProjectionItems(current, recovered)
  assert.equal(merged.length, 3)
  assert.equal(merged[0]?.id, 'entry-user-1')
  assert.equal(merged[1]?.kind === 'message' ? merged[1].text : '', 'newer-live')
  assert.equal(merged[2]?.kind, 'tool')
})

test('streaming reducer updates the newest matching active node', () => {
  const items = [
    { id: 'message:a1:0', kind: 'message' as const, role: 'assistant' as const, text: 'historical', streaming: false },
    { id: 'separator', kind: 'message' as const, role: 'user' as const, text: 'next', streaming: false },
    { id: 'message:a1:0', kind: 'message' as const, role: 'assistant' as const, text: 'current-', streaming: true },
  ]

  const next = reduceLiveTaskEvent(items, event(7, {
    type: 'text.delta',
    messageId: 'a1',
    contentIndex: 0,
    delta: 'tail',
  }))

  assert.equal(next[0]?.kind === 'message' ? next[0].text : '', 'historical')
  assert.equal(next[2]?.kind === 'message' ? next[2].text : '', 'current-tail')
})

test('settling an interrupted active turn clears every running presentation state', () => {
  const settled = settleLiveTaskProjectionItems([
    { id: 'a1', kind: 'message', role: 'assistant', text: 'partial', streaming: true },
    { id: 'r1', kind: 'thinking', text: 'thinking', streaming: true },
    { id: 'tool-1', kind: 'tool', callId: 'call-1', name: 'read', status: 'running' },
  ])

  assert.equal(settled[0]?.kind === 'message' ? settled[0].streaming : true, false)
  assert.equal(settled[1]?.kind === 'thinking' ? settled[1].streaming : true, false)
  assert.equal(settled[2]?.kind === 'tool' ? settled[2].status : '', 'success')
})

test('Live input history comes from submitted user messages and keeps chronological duplicates', () => {
  const items = projectLiveSnapshotEntries([
    { id: 'u1', role: 'user', content: 'first' },
    { id: 'a1', role: 'assistant', content: 'reply' },
    { id: 'u2', role: 'user', content: 'second' },
    { id: 'u3', role: 'user', content: 'second' },
  ])

  assert.deepEqual(projectLiveInputHistory(items), ['first', 'second', 'second'])
  assert.deepEqual(appendLiveInputHistory(['first'], ' second '), ['first', 'second'])
  assert.deepEqual(appendLiveInputHistory(['a', 'b'], 'c', 2), ['b', 'c'])
})


test('generic Live projection restores semantic rounds from user-message boundaries', () => {
  const items = [
    { id: 'u1', kind: 'message' as const, role: 'user' as const, text: 'first task', streaming: false, at: '2026-09-17T12:00:00.000Z' },
    { id: 'a1', kind: 'message' as const, role: 'assistant' as const, text: 'done', streaming: false, at: '2026-09-17T12:00:01.000Z' },
    { id: 't1', kind: 'tool' as const, callId: 'tool-1', name: 'read', status: 'success' as const, at: '2026-09-17T12:00:02.000Z' },
    { id: 'u2', kind: 'message' as const, role: 'user' as const, text: 'second task', streaming: false, at: '2026-09-17T12:00:03.000Z' },
    { id: 'r2', kind: 'thinking' as const, text: 'working', streaming: true, at: '2026-09-17T12:00:04.000Z' },
  ]

  const rounds = projectLiveTaskRounds(items)
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0]?.model.ordinal, 1)
  assert.equal(rounds[0]?.model.preview, 'first task')
  assert.equal(rounds[0]?.model.toolCount, 1)
  assert.equal(rounds[0]?.model.state, 'settled')
  assert.equal(rounds[1]?.model.ordinal, 2)
  assert.equal(rounds[1]?.model.preview, 'second task')
  assert.equal(rounds[1]?.model.state, 'running')
  assert.ok(liveTaskRoundEstimate(rounds[0]!) >= 180)
})

test('generic Live transcript classification ignores control-only events', () => {
  assert.equal(liveEventChangesTaskTranscript({ type: 'title.update', title: 'Task' }), false)
  assert.equal(liveEventChangesTaskTranscript({ type: 'status', status: 'running' }), false)
  assert.equal(liveEventChangesTaskTranscript({ type: 'queue.update', steering: [], followUp: [] }), false)
  assert.equal(liveEventChangesTaskTranscript({ type: 'text.delta', delta: 'x' }), true)
  assert.equal(liveEventChangesTaskTranscript({ type: 'completed', status: 'completed' }), true)
  assert.equal(liveEventChangesTaskTranscript({ type: 'error', message: 'network failure' }), true)
  assert.equal(liveEventChangesTaskTranscript({ type: 'status', status: 'failed' }), true)
  assert.equal(liveEventChangesTaskTranscript({ type: 'status', status: 'ready' }), false)
})

test('generic Live round projector reuses stable history while streaming the current turn', () => {
  const stable = [
    { id: 'u1', kind: 'message' as const, role: 'user' as const, text: 'first', streaming: false },
    { id: 'a1', kind: 'message' as const, role: 'assistant' as const, text: 'done', streaming: false },
  ]
  const current = [
    { id: 'u2', kind: 'message' as const, role: 'user' as const, text: 'second', streaming: false },
    { id: 'a2', kind: 'message' as const, role: 'assistant' as const, text: 'hel', streaming: true },
  ]
  const projector = new LiveTaskRoundProjector()
  const first = projector.project([...stable, ...current], stable.length)
  const stableRound = first[0]

  const next = projector.project([
    ...stable,
    current[0]!,
    { ...current[1]!, text: 'hello' },
  ], stable.length)

  assert.equal(next[0], stableRound)
  assert.equal(next[1]?.model.ordinal, 2)
  assert.equal(next[1]?.items[1]?.kind === 'message' ? next[1].items[1].text : '', 'hello')
})

test('generic Live stable round boundary excludes the active semantic turn', () => {
  const items = [
    { id: 'u1', kind: 'message' as const, role: 'user' as const, text: 'first', streaming: false },
    { id: 'a1', kind: 'message' as const, role: 'assistant' as const, text: 'done', streaming: false },
    { id: 'u2', kind: 'message' as const, role: 'user' as const, text: 'second', streaming: false },
    { id: 'a2', kind: 'message' as const, role: 'assistant' as const, text: 'working', streaming: true },
  ]
  assert.equal(liveTaskStableRoundPrefixLength(items, true), 2)
  assert.equal(liveTaskStableRoundPrefixLength(items, false), 4)
})

test('Live 长轮次不再按 8 条记录拆出多个处理详情，思考和工具完整保留', () => {
  const items = [
    { id: 'u1', kind: 'message' as const, role: 'user' as const, text: '配置三台虚拟机开机自启', streaming: false },
    ...Array.from({ length: 26 }, (_, index) => index % 4 === 0
      ? { id: `thought-${index}`, kind: 'thinking' as const, text: `思考 ${index}`, streaming: false }
      : { id: `tool-${index}`, kind: 'tool' as const, callId: `call-${index}`, name: 'shell', status: 'success' as const }),
    { id: 'answer', kind: 'message' as const, role: 'assistant' as const, text: '执行完毕', streaming: false },
    { id: 'u2', kind: 'message' as const, role: 'user' as const, text: '检查状态', streaming: false },
    { id: 'thought-2', kind: 'thinking' as const, text: '检查中', streaming: false },
  ]

  const rounds = projectLiveTaskRounds(items)
  assert.equal(rounds.length, 2, '真实两轮只展示两组，禁止按事实数拆出额外处理详情')
  assert.deepEqual(rounds.map(round => round.model.semanticId), ['live-round:u1', 'live-round:u2'])
  assert.deepEqual(rounds.map(round => round.model.id), ['live-round:u1', 'live-round:u2'])
  assert.equal(rounds[0]?.items.length, 28)
  assert.equal(rounds[0]?.items.filter(item => item.kind === 'thinking').length, 7)
  assert.equal(rounds[0]?.model.toolCount, 19)
  assert.equal(rounds[1]?.items.length, 2)
})


test('generic Live projection preserves pre-user activity as a background round', () => {
  const rounds = projectLiveTaskRounds([
    { id: 'a0', kind: 'message', role: 'assistant', text: 'restored output', streaming: false },
    { id: 'u1', kind: 'message', role: 'user', text: 'continue', streaming: false },
  ])
  assert.equal(rounds.length, 2)
  assert.equal(rounds[0]?.model.ordinal, undefined)
  assert.equal(rounds[0]?.items[0]?.id, 'a0')
  assert.equal(rounds[1]?.model.ordinal, 1)
})

test('a complete native reasoning interval is needed before displaying thinking duration', () => {
  let items = reduceLiveTaskEvent([], event(1, { type: 'reasoning.start', contentIndex: 0, text: '' }))
  items = reduceLiveTaskEvent(items, event(2, { type: 'reasoning.delta', contentIndex: 0, delta: 'investigating' }))
  const pendingThinking = items.find(item => item.kind === 'thinking')
  assert.ok(pendingThinking?.kind === 'thinking')
  assert.equal(pendingThinking.durationMs, undefined)
  items = reduceLiveTaskEvent(items, event(5, { type: 'reasoning.end', contentIndex: 0, text: 'investigating' }))
  const thinking = items.find(item => item.kind === 'thinking')
  assert.ok(thinking?.kind === 'thinking')
  assert.equal(thinking.durationMs, 4_000)
  assert.equal(thinking.streaming, false)
  const unpaired = reduceLiveTaskEvent([], event(6, { type: 'reasoning.end', contentIndex: 1, text: 'late' }))
  const unpairedThinking = unpaired.find(item => item.kind === 'thinking')
  assert.ok(unpairedThinking?.kind === 'thinking')
  assert.equal(unpairedThinking.durationMs, undefined)
})

test('未标注阶段的 Live Snapshot 不猜测 final；仅按原生 stopReason 识别工具续执行', () => {
  const items = projectLiveSnapshotEntries([
    { id: 'unknown', role: 'assistant', content: 'plain output' },
    { id: 'working', type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'check files' }] } },
    { id: 'finished', type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } },
  ])
  assert.deepEqual(items.filter(item => item.kind === 'message').map(item => item.kind === 'message' ? item.phase : undefined), [undefined, 'commentary', 'final'])
})

test('Pi Live 文本进入新阶段后旧思考/正文停止显示生成中，迟到 delta 仍保留内容', () => {
  let items = reduceLiveTaskEvent([], event(1, { type: 'reasoning.start', messageId: 'a1', contentIndex: 0, text: '' }))
  items = reduceLiveTaskEvent(items, event(2, { type: 'reasoning.delta', messageId: 'a1', contentIndex: 0, delta: '思考中' }))
  items = reduceLiveTaskEvent(items, event(3, { type: 'text.start', messageId: 'a1', contentIndex: 1, text: '' }))
  items = reduceLiveTaskEvent(items, event(4, { type: 'text.delta', messageId: 'a1', contentIndex: 1, delta: '分析结果' }))
  const thought = items.find(item => item.kind === 'thinking')
  assert.ok(thought?.kind === 'thinking')
  assert.equal(thought.streaming, false)
  items = reduceLiveTaskEvent(items, event(5, { type: 'reasoning.delta', messageId: 'a1', contentIndex: 0, delta: '补充' }))
  const lateThought = items.find(item => item.kind === 'thinking')
  assert.ok(lateThought?.kind === 'thinking')
  assert.equal(lateThought.text, '思考中补充')
  assert.equal(lateThought.streaming, false)
  const response = items.find(item => item.kind === 'message')
  assert.ok(response?.kind === 'message')
  assert.equal(response.streaming, true)
})

test('工具开始时旧正文停止生成提示；并发工具仍各自运行', () => {
  let items = reduceLiveTaskEvent([], event(1, { type: 'text.start', messageId: 'a1', contentIndex: 0, text: '准备检查' }))
  items = reduceLiveTaskEvent(items, event(2, { type: 'tool.start', callId: 'one', name: 'read' }))
  items = reduceLiveTaskEvent(items, event(3, { type: 'tool.start', callId: 'two', name: 'shell' }))
  const firstMessage = items.find(item => item.kind === 'message')
  assert.ok(firstMessage?.kind === 'message')
  assert.equal(firstMessage.streaming, false)
  assert.deepEqual(items.filter(item => item.kind === 'tool').map(item => item.status), ['running', 'running'])
})

test('即使原生 assistant message.end 没有 phase，也结束对应消息但不猜测 final', () => {
  let items = reduceLiveTaskEvent([], event(1, { type: 'text.start', messageId: 'a1', contentIndex: 0, text: '回应' }))
  items = reduceLiveTaskEvent(items, event(2, { type: 'message.end', role: 'assistant', messageId: 'a1' }))
  const message = items[0]
  assert.ok(message?.kind === 'message')
  assert.equal(message.streaming, false)
  assert.equal(message.phase, undefined)
})

test('Pi assistant 消息结束可兜底关闭缺失 reasoning.end 的思考块', () => {
  let items = reduceLiveTaskEvent([], event(1, {
    type: 'reasoning.start', messageId: 'assistant-a', contentIndex: 0, text: '思考',
  }))
  items = reduceLiveTaskEvent(items, event(2, {
    type: 'message.end', role: 'assistant', messageId: 'assistant-a',
  }))
  const thought = items[0]
  assert.ok(thought?.kind === 'thinking')
  assert.equal(thought.streaming, false)
})

test('Pi persisted assistant error without text survives snapshot, round projection and reload', () => {
  const items = projectLiveSnapshotEntries([
    { type: 'message', id: 'u-422', message: { role: 'user', content: [{ type: 'text', text: '你好' }] } },
    {
      type: 'message', id: 'a-422', timestamp: '2026-10-20T10:00:00.000Z',
      message: { role: 'assistant', stopReason: 'error', content: [], errorMessage: 'HTTP 422: developer role is not supported' },
    },
  ])
  assert.equal(items.length, 2)
  assert.deepEqual(items[1], {
    id: 'a-422:error', kind: 'message', role: 'assistant',
    text: 'HTTP 422: developer role is not supported',
    error: true, streaming: false, at: '2026-10-20T10:00:00.000Z',
  })
  const rounds = projectLiveTaskRounds(items)
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0]?.model.errorCount, 1)
  assert.equal(rounds[0]?.items[1]?.id, 'a-422:error')
})

test('partial assistant response and its separate persisted error are both visible in order', () => {
  const items = projectLiveSnapshotEntries([
    {
      type: 'message', id: 'a-partial',
      message: { role: 'assistant', stopReason: 'error',
        content: [{ type: 'text', text: 'partial output' }],
        errorMessage: 'HTTP 422: model rejected request' },
    },
    { id: 'flat-error', role: 'assistant', errorMessage: 'HTTP 502: upstream unavailable' },
  ])
  assert.equal(items.length, 3)
  assert.equal(items[0]?.kind === 'message' ? items[0].text : null, 'partial output')
  assert.equal(items[1]?.kind === 'message' ? items[1].text : null, 'HTTP 422: model rejected request')
  assert.equal(items[1]?.kind === 'message' ? items[1].error : null, true)
  assert.equal(items[2]?.id, 'flat-error:error')
  assert.equal(items[2]?.kind === 'message' ? items[2].error : null, true)
  assert.equal(projectLiveSnapshotEntries([
    { type: 'message', id: 'ok', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] } },
  ]).some(item => item.kind === 'message' && item.error), false)
})

test('all failures from generic SSE events appear in the same user round, independently of HTTP status', () => {
  const start = [{ id: 'u1', kind: 'message' as const, role: 'user' as const, text: 'request', streaming: false }]
  const cases = [
    'HTTP 400: invalid request',
    'HTTP 401: unauthorized',
    'HTTP 403: forbidden',
    'HTTP 429: quota exceeded',
    'HTTP 500: internal error',
    'HTTP 503: overloaded',
    'ECONNRESET: upstream disconnected',
    'Model context window exceeded',
  ]
  for (const message of cases) {
    const result = reduceLiveTaskEvent(start, event(1, { type: 'error', message }))
    const failure = result[1]
    assert.equal(failure?.kind, 'message')
    assert.equal(failure?.kind === 'message' ? failure.error : false, true)
    assert.equal(failure?.kind === 'message' ? failure.text : '', message)
    assert.equal(projectLiveTaskRounds(result)[0]?.model.errorCount, 1)
  }
})

test('terminal Runtime failures and missing error details are always visible', () => {
  const base = [{ id: 'u1', kind: 'message' as const, role: 'user' as const, text: 'hello', streaming: false }]
  const runtimeFailed = reduceLiveTaskEvent(base, event(1, { type: 'status', status: 'failed', message: 'Worker exited' }))
  assert.equal(runtimeFailed.at(-1)?.kind === 'message' ? runtimeFailed.at(-1)?.text : '', 'Worker exited')
  assert.equal(runtimeFailed.at(-1)?.kind === 'message' ? runtimeFailed.at(-1)?.error : false, true)
  const ended = reduceLiveTaskEvent(runtimeFailed, event(2, { type: 'completed', status: 'failed', message: 'Worker exited' }))
  assert.equal(ended.length, runtimeFailed.length)
  const withPendingTool = [...base, {
    id: 'tool:pending', kind: 'tool' as const, callId: 'pending',
    name: 'shell', status: 'running' as const,
  }]
  const crashed = reduceLiveTaskEvent(withPendingTool, event(5, {
    type: 'status', status: 'failed', message: 'Worker terminated',
  }))
  assert.equal(crashed[1]?.kind === 'tool' ? crashed[1].status : null, 'error')
  const noDetails = reduceLiveTaskEvent(base, event(3, { type: 'completed', status: 'failed' }))
  assert.equal(noDetails.at(-1)?.kind === 'message' ? noDetails.at(-1)?.error : false, true)
  assert.ok(noDetails.at(-1)?.kind === 'message' && noDetails.at(-1)?.text.length)
  assert.deepEqual(reduceLiveTaskEvent(base, event(4, { type: 'completed', status: 'cancelled' })), base)
})

test('persisted generic error wrappers, objects, tool failures and assistant stop errors remain readable', () => {
  const items = projectLiveSnapshotEntries([
    { id: 'provider', type: 'error', error: { message: 'HTTP 409: conflict' } },
    { id: 'runtime', type: 'runtime_status', status: 'failed', errorMessage: 'Runtime startup failed' },
    { id: 'tool', role: 'toolResult', toolCallId: 'call-1', isError: true, content: [] },
    { id: 'assistant', role: 'assistant', stopReason: 'error', content: [] },
    { id: 'assistant-nested', role: 'assistant', error: { detail: 'Parser rejected response' } },
  ])
  const errors = items.filter(item => item.kind === 'message' && item.error)
  assert.equal(errors.length, 4)
  assert.equal(errors[0]?.kind === 'message' ? errors[0].text : '', 'HTTP 409: conflict')
  assert.equal(errors[1]?.kind === 'message' ? errors[1].text : '', 'Runtime startup failed')
  assert.ok(errors[2]?.kind === 'message' && errors[2].text.trim())
  assert.equal(errors[3]?.kind === 'message' ? errors[3].text : '', 'Parser rejected response')
  const tool = items.find(item => item.kind === 'tool')
  assert.equal(tool?.kind === 'tool' ? tool.status : null, 'error')
  assert.ok(tool?.kind === 'tool' && tool.output)
})

test('SSE failure reconciles with persisted error instead of duplicating the same failure', () => {
  const user = { id: 'user:1', kind: 'message' as const, role: 'user' as const, text: 'hello', streaming: false }
  const live = reduceLiveTaskEvent([user], event(1, { type: 'error', message: 'Network timeout' }))
  const snapshot = projectLiveSnapshotEntries([
    { id: 'persisted-1', role: 'assistant', errorMessage: 'Network timeout' },
  ])
  const reconciled = mergeLiveActiveProjectionItems(live, snapshot)
  assert.equal(reconciled.length, 2)
  assert.equal(reconciled[1]?.id, 'persisted-1:error')
  const anotherTurn = reduceLiveTaskEvent([
    ...reconciled,
    { id: 'user:2', kind: 'message', role: 'user', text: 'retry', streaming: false },
  ], event(2, { type: 'error', message: 'Network timeout' }))
  assert.equal(anotherTurn.filter(item => item.kind === 'message' && item.error).length, 2)
})


test('cancelled and interrupted completion never mark unfinished tools successful', () => {
  const base = [
    { id: 'u1', kind: 'message' as const, role: 'user' as const, text: 'run', streaming: false },
    { id: 'tool:t1', kind: 'tool' as const, callId: 't1', name: 'shell', status: 'running' as const },
  ]
  for (const status of ['cancelled', 'interrupted'] as const) {
    const items = reduceLiveTaskEvent(base, event(10, { type: 'completed', status }))
    assert.equal(items[1]?.kind === 'tool' ? items[1].status : null, 'error')
    assert.equal(items.some(item => item.kind === 'message' && item.error), false)
  }
  const complete = reduceLiveTaskEvent(base, event(11, { type: 'completed', status: 'completed' }))
  assert.equal(complete[1]?.kind === 'tool' ? complete[1].status : null, 'success')
})

test('generic snapshot errors preserve code, nested cause and error arrays without HTTP-specific branches', () => {
  const entries = [
    { id: 'code-only', type: 'error', error: { code: 'ETIMEDOUT' } },
    { id: 'nested', type: 'error', error: { code: 'PROVIDER_ERROR', cause: { message: 'connection dropped' } } },
    { id: 'aggregate', type: 'error', error: { errors: [{ message: 'first failure' }, { code: 503, detail: 'retry later' }] } },
  ]
  const projected = projectLiveSnapshotEntries(entries)
  assert.deepEqual(projected.filter(item => item.kind === 'message' && item.error).map(item => item.kind === 'message' ? item.text : ''), [
    'ETIMEDOUT',
    'PROVIDER_ERROR: connection dropped',
    'first failure; 503: retry later',
  ])
  const cyclic: { code: string; cause?: unknown } = { code: 'CYCLE' }
  cyclic.cause = cyclic
  assert.equal(projectLiveSnapshotEntries([{ id: 'cyclic', type: 'error', error: cyclic }])[0]?.kind === 'message'
    ? (projectLiveSnapshotEntries([{ id: 'cyclic', type: 'error', error: cyclic }])[0] as { text: string }).text : '', 'CYCLE')
})

test('generic structured Live error keeps code/category/retryability with no provider branching', () => {
  const initial = [{ id: 'u1', kind: 'message' as const, role: 'user' as const, text: 'hello', streaming: false }]
  const result = reduceLiveTaskEvent(initial, event(1, {
    type: 'error', message: '', code: 'MODEL_UNAVAILABLE', category: 'provider', retryable: true,
  }))
  const failure = result.at(-1)
  assert.ok(failure?.kind === 'message')
  assert.equal(failure.text, 'MODEL_UNAVAILABLE')
  assert.equal(failure.error, true)
  assert.deepEqual(failure.errorDiagnostic, {
    code: 'MODEL_UNAVAILABLE', category: 'provider', retryable: true,
  })
  const legacy = reduceLiveTaskEvent(initial, event(2, { type: 'error', message: 'plain failure' }))
  assert.equal(legacy.at(-1)?.kind === 'message' ? legacy.at(-1).text : '', 'plain failure')
})

test('reconnect retains structured SSE diagnostic when native snapshot has the same error text', () => {
  const before = reduceLiveTaskEvent([
    { id: 'u1', kind: 'message' as const, role: 'user' as const, text: 'hello', streaming: false },
  ], event(1, {
    type: 'error', message: 'network unavailable', code: 'UPSTREAM_TIMEOUT', category: 'network', retryable: true,
  }))
  const persisted = projectLiveSnapshotEntries([
    { id: 'native-error', role: 'assistant', errorMessage: 'network unavailable' },
  ])
  const merged = mergeLiveActiveProjectionItems(before, persisted)
  const error = merged.find(item => item.kind === 'message' && item.error)
  assert.ok(error?.kind === 'message')
  assert.equal(error.id, 'native-error:error')
  assert.deepEqual(error.errorDiagnostic, {
    code: 'UPSTREAM_TIMEOUT', category: 'network', retryable: true,
  })
  assert.equal(merged.filter(item => item.kind === 'message' && item.error).length, 1)
})
