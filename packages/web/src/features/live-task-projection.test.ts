import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveRuntimeEventDto } from '@agent-lens/protocol'
import {
  appendLiveInputHistory,
  appendOptimisticLiveUserMessage,
  LiveTaskRoundProjector,
  liveEventChangesTaskTranscript,
  liveTaskStableRoundPrefixLength,
  liveTaskResponseActivity,
  sourceNativeUsageDetail,
  mergeLiveActiveProjectionItems,
  preserveOptimisticImagePreviews,
  reconcileLiveSnapshotProjection,
  projectLiveInputHistory,
  projectLiveSnapshotEntries,
  projectLiveTaskRounds,
  liveTaskRoundEstimate,
  liveLoadedToolRelations,
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

test('Live native handoff reuses decoded outgoing images without duplicating the user message', () => {
  const outgoing = appendOptimisticLiveUserMessage([], '看图', 'user:pending-1', [{
    type: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,bG9jYWw=',
  }])
  const native = projectLiveSnapshotEntries([{
    type: 'message',
    id: 'native-1',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', mimeType: 'image/png', data: 'bmF0aXZl' },
      ],
    },
  }])
  const merged = mergeLiveActiveProjectionItems(outgoing, native)
  assert.equal(merged.length, 1)
  const message = merged[0]
  assert.ok(message?.kind === 'message')
  assert.equal(message.id, 'native-1')
  assert.equal(message.entryId, 'native-1')
  assert.equal(message.attachments?.[0]?.dataUrl, 'data:image/png;base64,bG9jYWw=')

  const reconciled = reconcileLiveSnapshotProjection(
    { stable: [], active: outgoing },
    { stable: native, active: [] },
    false,
  )
  const stable = reconciled.stable[0]
  assert.ok(stable?.kind === 'message')
  assert.equal(stable.attachments?.[0]?.dataUrl, 'data:image/png;base64,bG9jYWw=')

  // A later native refresh must not replace the decoded source a second time.
  const refreshed = reconcileLiveSnapshotProjection(
    { stable: reconciled.stable, active: [] },
    { stable: native, active: [] },
    false,
  )
  const retained = refreshed.stable[0]
  assert.ok(retained?.kind === 'message')
  assert.equal(retained.attachments?.[0]?.dataUrl, 'data:image/png;base64,bG9jYWw=')
})

test('settled Live recovery preserves only matching outgoing native images', () => {
  const outgoing = appendOptimisticLiveUserMessage([], '', 'user:image-only', [{
    type: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,cHJldmlldw==',
  }])
  const native = projectLiveSnapshotEntries([{
    type: 'message', id: 'native-image', message: {
      role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'bmF0aXZl' }],
    },
  }])
  const [kept] = preserveOptimisticImagePreviews(outgoing, native)
  assert.ok(kept?.kind === 'message')
  assert.equal(kept.attachments?.[0]?.dataUrl, 'data:image/png;base64,cHJldmlldw==')

  const withoutImage = projectLiveSnapshotEntries([{
    type: 'message', id: 'native-text', message: {
      role: 'user', content: '看图',
    },
  }])
  const [unchanged] = preserveOptimisticImagePreviews(outgoing, withoutImage)
  assert.ok(unchanged?.kind === 'message')
  assert.equal(unchanged.attachments, undefined)
})

test('repeated Live prompts give the most recent native image its own preview', () => {
  const outgoing = [
    ...appendOptimisticLiveUserMessage([], '相同问题', 'user:first', [{
      type: 'image', dataUrl: 'data:image/png;base64,Zmlyc3Q=',
    }]),
    ...appendOptimisticLiveUserMessage([], '相同问题', 'user:second', [{
      type: 'image', dataUrl: 'data:image/png;base64,c2Vjb25k',
    }]),
  ]
  const native = projectLiveSnapshotEntries([
    { type: 'message', id: 'native:first', message: { role: 'user', content: [
      { type: 'text', text: '相同问题' },
      { type: 'image', mimeType: 'image/png', data: 'bmF0aXZlMQ==' },
    ] } },
    { type: 'message', id: 'native:second', message: { role: 'user', content: [
      { type: 'text', text: '相同问题' },
      { type: 'image', mimeType: 'image/png', data: 'bmF0aXZlMg==' },
    ] } },
  ])
  const kept = preserveOptimisticImagePreviews(outgoing, native)
  assert.equal(kept[0]?.kind === 'message' ? kept[0].attachments?.[0]?.dataUrl : undefined, 'data:image/png;base64,Zmlyc3Q=')
  assert.equal(kept[1]?.kind === 'message' ? kept[1].attachments?.[0]?.dataUrl : undefined, 'data:image/png;base64,c2Vjb25k')
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
    error: true, errorScope: 'attempt', streaming: false, at: '2026-10-20T10:00:00.000Z',
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
  const runtimeFailure = runtimeFailed.at(-1)
  assert.equal(runtimeFailure?.kind === 'message' ? runtimeFailure.text : '', 'Worker exited')
  assert.equal(runtimeFailure?.kind === 'message' ? runtimeFailure.error : false, true)
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
  const emptyDetailFailure = noDetails.at(-1)
  assert.equal(emptyDetailFailure?.kind === 'message' ? emptyDetailFailure.error : false, true)
  assert.ok(emptyDetailFailure?.kind === 'message' && emptyDetailFailure.text.length)
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

test('failed Pi model attempt remains visible while its logical run continues streaming', () => {
  const user = { id: 'user-1', kind: 'message' as const, role: 'user' as const,
    text: 'read the log', streaming: false }
  const attempt = reduceLiveTaskEvent([user], event(1, {
    type: 'error', scope: 'attempt', message: 'Connection error.',
  }))
  const failure = attempt.at(-1)
  assert.equal(failure?.kind === 'message' ? failure.errorScope : undefined, 'attempt')
  assert.equal(failure?.kind === 'message' ? failure.error : undefined, true)

  const continuing = reduceLiveTaskEvent(attempt, event(2, {
    type: 'text.start', messageId: 'retry-response', text: 'Checking files',
  }))
  const streamed = continuing.at(-1)
  assert.equal(streamed?.kind === 'message' ? streamed.streaming : null, true)
  const final = reduceLiveTaskEvent(continuing, event(3, {
    type: 'text.end', messageId: 'retry-response', text: 'Found the configuration',
  }))
  const resumed = final.at(-1)
  assert.equal(resumed?.kind === 'message' ? resumed.text : null, 'Found the configuration')
  assert.equal(final.filter(item => item.kind === 'message' && item.errorScope === 'attempt').length, 1)
  assert.equal(final.some(item => item.kind === 'message' && item.error && !item.errorScope), false)

  const native = projectLiveSnapshotEntries([
    { type: 'message', id: 'native-error', message: { role: 'assistant',
      stopReason: 'error', content: [], errorMessage: 'Connection error.' } },
    { type: 'message', id: 'native-reply', message: { role: 'assistant',
      stopReason: 'stop', content: [{ type: 'text', text: 'Found the configuration' }] } },
  ])
  const fromHistory = native.find(item => item.kind === 'message' && item.error)
  assert.equal(fromHistory?.kind === 'message' ? fromHistory.errorScope : null, 'attempt')
  const merged = mergeLiveActiveProjectionItems(attempt, native)
  assert.equal(merged.filter(item => item.kind === 'message' && item.error).length, 1)
  const reconciledFailure = merged.find(item => item.kind === 'message' && item.error)
  assert.equal(reconciledFailure?.kind === 'message' ? reconciledFailure.errorScope : null, 'attempt')
  assert.ok(merged.some(item => item.kind === 'message' && !item.error
    && item.role === 'assistant' && item.text === 'Found the configuration'))
})

test('Pi retry success records a warning, never a failed final round', () => {
  const user = { id: 'u', kind: 'message' as const, role: 'user' as const, text: 'task', streaming: false }
  const failedAttempt = reduceLiveTaskEvent([user], event(1, {
    type: 'error', scope: 'attempt', message: 'Connection error.',
  }))
  const output = reduceLiveTaskEvent(failedAttempt, event(2, {
    type: 'text.end', messageId: 'retry', text: 'done',
  }))
  const settled = reduceLiveTaskEvent(output, event(3, {
    type: 'completed', status: 'completed',
  }))
  const round = projectLiveTaskRounds(settled)[0]
  assert.equal(round?.model.errorCount, 1)
  assert.equal(round?.model.warningCount, 1)
  assert.equal(round?.model.terminalFailure, false)
  assert.equal(settled.filter(item => item.kind === 'message' && item.error).length, 1)
  assert.ok(settled.some(item => item.kind === 'message' && item.text === 'done'))
})

test('Pi final failure upgrades the last failed attempt without duplicating it', () => {
  const initial = [{ id: 'u', kind: 'message' as const, role: 'user' as const, text: 'task', streaming: false }]
  const attempt = reduceLiveTaskEvent(initial, event(1, {
    type: 'error', scope: 'attempt', message: 'Connection error.',
  }))
  for (const completed of [
    { type: 'completed', status: 'failed' } as const,
    { type: 'completed', status: 'failed', message: 'Connection error.' } as const,
  ]) {
    const settled = reduceLiveTaskEvent(attempt, event(2, completed))
    const failures = settled.filter(item => item.kind === 'message' && item.error)
    assert.equal(failures.length, 1)
    assert.equal(failures[0]?.kind === 'message' ? failures[0].errorScope : null, undefined)
    assert.equal(failures[0]?.kind === 'message' ? failures[0].terminalFailure : null, true)
    const round = projectLiveTaskRounds(settled)[0]
    assert.equal(round?.model.terminalFailure, true)
    assert.equal(round?.model.warningCount, 0)
  }
})

test('generic Live errors are visible warnings until a terminal failure is explicit', () => {
  const user = { id: 'u', kind: 'message' as const, role: 'user' as const, text: 'task', streaming: false }
  const transient = reduceLiveTaskEvent([user], event(1, {
    type: 'error', message: 'Extension failed',
  }))
  const round = projectLiveTaskRounds(transient)[0]
  assert.equal(round?.model.warningCount, 1)
  assert.equal(round?.model.terminalFailure, false)

  const ended = reduceLiveTaskEvent(transient, event(2, {
    type: 'status', status: 'failed', message: 'Runtime exited',
  }))
  const failed = projectLiveTaskRounds(ended)[0]
  assert.equal(failed?.model.terminalFailure, true)
  assert.ok(ended.some(item => item.kind === 'message' && item.terminalFailure))
})

test('native snapshot last successful assistant supersedes an earlier failed attempt', () => {
  const projected = projectLiveSnapshotEntries([
    { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'task' }] } },
    { type: 'message', id: 'failed', message: {
      role: 'assistant', stopReason: 'error', content: [], errorMessage: 'Connection error.',
    } },
    { type: 'message', id: 'success', message: {
      role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }],
    } },
  ])
  const round = projectLiveTaskRounds(projected)[0]
  assert.equal(round?.model.warningCount, 1)
  assert.equal(round?.model.terminalFailure, false)
  assert.ok(round?.items.some(item => item.kind === 'message' && item.phase === 'final'))
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
  if (failure?.kind !== 'message') throw new Error('Expected a failure message')
  assert.equal(failure.text, 'MODEL_UNAVAILABLE')
  assert.equal(failure.error, true)
  assert.deepEqual(failure.errorDiagnostic, {
    code: 'MODEL_UNAVAILABLE', category: 'provider', retryable: true,
  })
  const legacy = reduceLiveTaskEvent(initial, event(2, { type: 'error', message: 'plain failure' }))
  const legacyFailure = legacy.at(-1)
  assert.equal(legacyFailure?.kind === 'message' ? legacyFailure.text : '', 'plain failure')
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

test('persisted native error includes code/category/retryable after page reload', () => {
  const items = projectLiveSnapshotEntries([
    { id: 'native-1', type: 'error', error: {
      code: 'SERVICE_DOWN', message: 'Service unavailable',
      category: 'runtime', retryable: false,
    } },
  ])
  const failure = items[0]
  assert.ok(failure?.kind === 'message')
  assert.equal(failure.error, true)
  assert.deepEqual(failure.errorDiagnostic, {
    code: 'SERVICE_DOWN', category: 'runtime', retryable: false,
  })
})

test('completed failures retain native diagnostics in the shared Task message', () => {
  const items = reduceLiveTaskEvent([], event(1, {
    type: 'completed', status: 'failed', message: 'runtime exited',
    code: 'RUNTIME_EXIT', category: 'runtime', retryable: false,
  }))
  const failure = items.find(item => item.kind === 'message' && item.error)
  assert.ok(failure && failure.kind === 'message')
  assert.equal(failure.text, 'runtime exited')
  assert.deepEqual(failure.errorDiagnostic, {
    code: 'RUNTIME_EXIT', category: 'runtime', retryable: false,
  })
})

test('active round stays running between completed tool events', () => {
  const projector = new LiveTaskRoundProjector()
  const items = [
    { id: 'user-gap', kind: 'message' as const, role: 'user' as const, text: 'task', streaming: false },
    { id: 'tool-done', kind: 'tool' as const, callId: 'done', name: 'read', status: 'success' as const },
    { id: 'thinking-gap', kind: 'thinking' as const, text: 'next action', streaming: false },
  ]
  const pending = projector.projectSegmented([], items)
  assert.equal(pending.active.length, 1)
  assert.equal(pending.active[0]?.model.state, 'running')
  const finished = projector.projectSegmented(items, [])
  assert.equal(finished.active.length, 0)
  assert.equal(finished.stable[0]?.model.state, 'settled')
})

test('recovery reuses unchanged snapshot facts and never discards newer live tail', () => {
  const stable = [{ id: 'history-a', kind: 'message' as const, role: 'user' as const, text: 'Earlier', streaming: false }]
  const active = [{ id: 'tool-1', kind: 'tool' as const, callId: 'call-1', name: 'shell', status: 'running' as const }]
  const old = { stable, active }
  const snapshot = {
    stable: [{ ...stable[0]! }],
    active: [{ ...active[0]! }],
  }
  assert.strictEqual(reconcileLiveSnapshotProjection(old, snapshot, true), old,
    'identical recovery must not invalidate the rendered timeline')

  const withNewerSse = { stable, active: [...active, {
    id: 'assistant-new', kind: 'message' as const, role: 'assistant' as const,
    text: 'newer than the snapshot', streaming: true,
  }] }
  const recovered = reconcileLiveSnapshotProjection(withNewerSse, snapshot, true)
  assert.strictEqual(recovered.stable, stable)
  assert.strictEqual(recovered.active, withNewerSse.active)
})

test('recovery repairs a tool result lost during SSE disconnect without duplicating rows', () => {
  const running = { id: 'tool-1', kind: 'tool' as const, callId: 'call-1', name: 'shell', status: 'running' as const }
  const completed = { ...running, status: 'success' as const, output: 'finished' }
  const updated = mergeLiveActiveProjectionItems([running], [completed])
  assert.equal(updated.length, 1)
  assert.equal(updated[0]?.kind === 'tool' ? updated[0].status : null, 'success')
  assert.strictEqual(mergeLiveActiveProjectionItems(updated, [completed]), updated,
    'replaying the same completed tool should reuse the projection')
})

test('恢复并入历史思考后只允许最新文本阶段动画，工具仍可并行', () => {
  const merged = mergeLiveActiveProjectionItems([
    { id: 'u', kind: 'message', role: 'user', text: '检查代码', streaming: false },
    { id: 't1', kind: 'thinking', text: 'DDL', streaming: true },
    { id: 'tool1', kind: 'tool', callId: '1', name: 'grep', status: 'running' },
  ], [
    { id: 'tool2', kind: 'tool', callId: '2', name: 'find', status: 'running' },
    { id: 't2', kind: 'thinking', text: '核对', streaming: true },
  ])
  assert.equal(merged[1]?.kind === 'thinking' && merged[1].streaming, false)
  assert.equal(merged[2]?.kind === 'tool' && merged[2].status, 'running')
  assert.equal(merged[3]?.kind === 'tool' && merged[3].status, 'running')
  assert.equal(merged[4]?.kind === 'thinking' && merged[4].streaming, true)
  const next = mergeLiveActiveProjectionItems(merged, [
    { id: 'tool3', kind: 'tool', callId: '3', name: 'git', status: 'success' },
  ])
  assert.equal(next[4]?.kind === 'thinking' && next[4].streaming, false)
})

test('等待首 token、思考、工具、正文及间隙按原生事实展示', () => {
  const user = { id: 'u', kind: 'message' as const, role: 'user' as const, text: '你好', streaming: false }
  assert.equal(liveTaskResponseActivity([user], false), null)
  assert.equal(liveTaskResponseActivity([user], true), 'waiting')
  assert.equal(liveTaskResponseActivity([user, { id: 'r', kind: 'thinking', text: '分析', streaming: true }], true), 'thinking')
  assert.equal(liveTaskResponseActivity([user, { id: 'tool', kind: 'tool', callId: 'a', name: 'read', status: 'running' }], true), 'tools')
  assert.equal(liveTaskResponseActivity([user, { id: 'a', kind: 'message', role: 'assistant', text: '你好', streaming: true }], true), 'responding')
  assert.equal(liveTaskResponseActivity([user, { id: 'tool', kind: 'tool', callId: 'a', name: 'read', status: 'success' }], true), 'processing')
})

test('Native retry and compaction are shared process facts, not terminal failures', () => {
  const user = { id: 'user', kind: 'message' as const, role: 'user' as const, text: 'help', streaming: false }
  const retry = reduceLiveTaskEvent([user], event(1, { type: 'status', status: 'running',
    process: { operation: 'retry', phase: 'start', attempt: 1, maxAttempts: 3, delayMs: 2000,
      errorMessage: 'service overloaded' } }))
  const compaction = reduceLiveTaskEvent(retry, event(2, { type: 'status', status: 'compacting',
    process: { operation: 'compaction', phase: 'start', reason: 'overflow' } }))
  const compacted = reduceLiveTaskEvent(compaction, event(3, { type: 'status', status: 'ready',
    process: { operation: 'compaction', phase: 'end', reason: 'overflow',
      outcome: 'success', summary: 'summary', tokensBefore: 150000,
      estimatedTokensAfter: 32000, willRetry: true } }))
  const failedRetry = reduceLiveTaskEvent(compacted, event(4, { type: 'status', status: 'running',
    process: { operation: 'retry', phase: 'end', outcome: 'failed',
      attempt: 3, errorMessage: 'final error' } }))
  const events = failedRetry.filter(item => item.kind === 'event')
  assert.deepEqual(events.map(item => item.kind === 'event' ? item.process.operation : ''), [
    'retry', 'compaction', 'compaction', 'retry',
  ])
  assert.equal(events[2]?.kind === 'event' ? events[2].process.summary : undefined, 'summary')
  assert.ok(liveEventChangesTaskTranscript({ type: 'status', status: 'compacting',
    process: { operation: 'compaction', phase: 'start' } }))
  const round = projectLiveTaskRounds(failedRetry)[0]
  assert.equal(round?.model.terminalFailure, false)
  assert.equal(round?.model.errorCount, 1)
  assert.equal(round?.model.warningCount, 1)
  assert.equal(round?.model.toolCount, 0)
  // An event without native process facts must not mutate the transcript.
  assert.equal(liveEventChangesTaskTranscript({ type: 'status', status: 'compacting' }), false)
})

test('Pi native tool result retains full text, image content and structured details', () => {
  const imageData = 'data:image/png;base64,aGVsbG8='
  const fullOutput = 'native result '.repeat(450)
  const items = projectLiveSnapshotEntries([
    {
      type: 'message', id: 'assistant-tool',
      message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'call-image', name: 'screenshot', arguments: { path: 'output.png' } },
      ] },
    },
    {
      type: 'message', id: 'tool-result-image',
      message: {
        role: 'toolResult', toolCallId: 'call-image', toolName: 'screenshot',
        isError: false,
        content: [
          { type: 'text', text: fullOutput },
          { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        ],
        details: { exitCode: 0, file: 'output.png', patches: [{ path: 'a.ts', lines: 2 }] },
      },
    },
  ])
  const tool = items.find(item => item.kind === 'tool')
  assert.ok(tool?.kind === 'tool')
  assert.equal(tool.output, fullOutput)
  assert.equal(tool.nativeResult, true)
  assert.deepEqual(tool.resultDetails, { exitCode: 0, file: 'output.png', patches: [{ path: 'a.ts', lines: 2 }] })
  assert.equal(tool.attachments?.[0]?.type, 'image')
  assert.equal(tool.attachments?.[0]?.dataUrl, imageData)
  assert.deepEqual(items.map(item => item.kind), ['tool'])
})

test('Pi native image-only tool result is not discarded when textual output is absent', () => {
  const [item] = projectLiveSnapshotEntries([{
    type: 'message', id: 'result-only',
    message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'view',
      content: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
      details: { rendered: true } },
  }])
  assert.ok(item?.kind === 'tool')
  assert.equal(item.output, undefined)
  assert.equal(item.attachments?.length, 1)
  assert.deepEqual(item.resultDetails, { rendered: true })
})

test('Pi persisted native tool result replaces settled truncated SSE output without losing call facts', () => {
  const initial = reduceLiveTaskEvent([], event(1, {
    type: 'tool.start', callId: 'call-1', name: 'view', inputPreview: '{"path":"a.png"}',
    parentToolCallId: 'parent-1',
  }))
  const settled = reduceLiveTaskEvent(initial, event(2, {
    type: 'tool.end', callId: 'call-1', name: 'view',
    output: 'truncated…', status: 'success',
  }))
  const [native] = projectLiveSnapshotEntries([{
    type: 'message', id: 'result-1',
    message: { role: 'toolResult', toolCallId: 'call-1',
      toolName: 'view', content: [{ type: 'text', text: 'complete native output' }],
      details: { result: 'complete' } },
  }])
  assert.ok(native?.kind === 'tool')
  const [merged] = mergeLiveActiveProjectionItems(settled, [native])
  assert.ok(merged?.kind === 'tool')
  assert.equal(merged.output, 'complete native output')
  assert.equal(merged.inputPreview, '{"path":"a.png"}')
  assert.equal(merged.parentToolCallId, 'parent-1')
  assert.equal(merged.nativeResult, true)
  assert.deepEqual(merged.resultDetails, { result: 'complete' })
})

test('Pi native compaction journal restores exact summary and tokens after refresh', () => {
  const summary = 'Source-backed summary '.repeat(250)
  const rows = projectLiveSnapshotEntries([{
    type: 'compaction', id: 'compaction-1',
    timestamp: '2026-11-05T08:00:00.000Z',
    summary, firstKeptEntryId: 'message-7', tokensBefore: 140_000,
  }])
  assert.equal(rows.length, 1)
  const item = rows[0]
  assert.ok(item?.kind === 'event')
  assert.equal(item.id, 'native-compaction:compaction-1')
  assert.deepEqual(item.process, {
    operation: 'compaction', phase: 'end', outcome: 'success',
    summary, firstKeptEntryId: 'message-7', tokensBefore: 140_000,
  })
  assert.equal(item.at, '2026-11-05T08:00:00.000Z')
  assert.equal(projectLiveSnapshotEntries([{ type: 'compaction', id: 'unknown', summary: '' }])
    .at(0)?.kind, 'event')
})

test('Pi compaction recovery merges matching SSE finish with native journal rather than duplicating', () => {
  const transcript = [
    { id: 'user-1', kind: 'message' as const, role: 'user' as const,
      text: 'fix long conversation', streaming: false },
  ]
  const transient = reduceLiveTaskEvent(transcript, event(1, {
    type: 'status', status: 'ready', process: {
      operation: 'compaction', phase: 'end', reason: 'overflow',
      summary: 'real summary', firstKeptEntryId: 'message-7',
      tokensBefore: 140_000, estimatedTokensAfter: 30_000, outcome: 'success',
    },
  }))
  const durable = projectLiveSnapshotEntries([{
    type: 'compaction', id: 'compaction-1',
    summary: 'real summary', firstKeptEntryId: 'message-7', tokensBefore: 140_000,
  }])
  const merged = mergeLiveActiveProjectionItems(transient, durable)
  const events = merged.filter(item => item.kind === 'event')
  assert.equal(events.length, 1)
  assert.equal(events[0]?.id, 'native-compaction:compaction-1')
  assert.equal(events[0]?.kind === 'event' ? events[0].process.reason : '', 'overflow')
  assert.equal(events[0]?.kind === 'event'
    ? events[0].process.estimatedTokensAfter : -1, 30_000)
  assert.equal(events[0]?.kind === 'event' ? events[0].process.tokensBefore : -1, 140_000)

  // Different native compactions cannot be collapsed on mere sequence proximity.
  const other = projectLiveSnapshotEntries([{
    type: 'compaction', id: 'compaction-2',
    summary: 'a different compaction', firstKeptEntryId: 'message-12',
  }])
  const distinct = mergeLiveActiveProjectionItems(merged, other)
  assert.equal(distinct.filter(item => item.kind === 'event').length, 2)
})

test('Pi source-attested length stop shows a nonterminal process warning with complete message', () => {
  const initial = reduceLiveTaskEvent([], event(1, {
    type: 'text.end', text: 'answer cut at native limit',
    messageId: 'native-msg-1', contentIndex: 0,
  }))
  const finished = reduceLiveTaskEvent(initial, event(2, {
    type: 'message.end', role: 'assistant', messageId: 'native-msg-1',
    stopReason: 'length',
  }))
  assert.ok(finished.some(item => item.kind === 'message'
    && item.text === 'answer cut at native limit' && !item.streaming))
  const truncated = finished.filter(item => item.kind === 'event')
  assert.equal(truncated.length, 1)
  assert.deepEqual(truncated[0]?.kind === 'event' ? truncated[0].process : null, {
    operation: 'output', phase: 'end', outcome: 'truncated', reason: 'length',
  })
  assert.equal(truncated[0]?.id, 'live-output:native-msg-1')
  const settled = reduceLiveTaskEvent(finished, event(3, {
    type: 'completed', status: 'completed',
  }))
  const round = projectLiveTaskRounds(settled)[0]
  assert.equal(round?.model.errorCount, 0)
  assert.equal(round?.model.warningCount, 1)
  assert.equal(round?.model.terminalFailure, false)
  assert.equal(round?.model.state, 'settled')
})

test('Pi persisted assistant length boundary survives history reload without claiming a normal final', () => {
  const rows = projectLiveSnapshotEntries([{
    type: 'message', id: 'entry-123', timestamp: '2026-11-05T10:00:00.000Z',
    message: { role: 'assistant', id: 'native-msg-1', stopReason: 'length',
      content: [{ type: 'text', text: 'cut short' }] },
  }])
  assert.deepEqual(rows.map(row => row.kind), ['message', 'event'])
  assert.equal(rows[1]?.id, 'live-output:native-msg-1')
  assert.equal(rows[1]?.kind === 'event' ? rows[1].process.outcome : null, 'truncated')
  const live = reduceLiveTaskEvent([], event(2, {
    type: 'message.end', role: 'assistant', messageId: 'native-msg-1',
    stopReason: 'length',
  }))
  const merged = mergeLiveActiveProjectionItems(live, rows)
  assert.equal(merged.filter(row => row.kind === 'event').length, 1)
  const ordinary = projectLiveSnapshotEntries([{
    type: 'message', id: 'entry-ok', message: {
      role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text: 'complete' }],
    },
  }])
  assert.equal(ordinary.filter(row => row.kind === 'event').length, 0)
})

test('Pi native parentToolCallId links loaded nested tools without assuming adjacency', () => {
  const input = [
    { id: 'outer', kind: 'tool' as const, callId: 'outer', name: 'orchestrate', status: 'running' as const },
    { id: 'content', kind: 'message' as const, role: 'assistant' as const, text: 'other process', streaming: false },
    { id: 'child-a', kind: 'tool' as const, callId: 'child-a', name: 'read', parentToolCallId: 'outer', status: 'success' as const },
    { id: 'child-b', kind: 'tool' as const, callId: 'child-b', name: 'edit', parentToolCallId: 'outer', status: 'success' as const },
    { id: 'grandchild', kind: 'tool' as const, callId: 'grandchild', name: 'search', parentToolCallId: 'child-a', status: 'success' as const },
    { id: 'other', kind: 'tool' as const, callId: 'other', name: 'terminal', status: 'success' as const },
  ]
  const relations = liveLoadedToolRelations(input)
  assert.deepEqual(relations.get('outer'), { loadedChildCallCount: 2 })
  assert.deepEqual(relations.get('child-a'), {
    parentToolCallId: 'outer', parentToolName: 'orchestrate', loadedChildCallCount: 1,
  })
  assert.deepEqual(relations.get('child-b'), { parentToolCallId: 'outer', parentToolName: 'orchestrate' })
  assert.deepEqual(relations.get('grandchild'), { parentToolCallId: 'child-a', parentToolName: 'read' })
  assert.equal(relations.has('other'), false)
  assert.deepEqual(input.map(item => item.id), [
    'outer', 'content', 'child-a', 'child-b', 'grandchild', 'other',
  ])
})

test('Unknown parent outside current window is labeled by its native ID, never a guessed tool', () => {
  const relations = liveLoadedToolRelations([
    { id: 'child', kind: 'tool', callId: 'child', name: 'read',
      parentToolCallId: 'not-in-loaded-window', status: 'running' },
    { id: 'self', kind: 'tool', callId: 'self', name: 'edit',
      parentToolCallId: 'self', status: 'running' },
  ])
  assert.deepEqual(relations.get('child'), { parentToolCallId: 'not-in-loaded-window' })
  assert.equal(relations.has('self'), false)
})

test('Pi special native journal entries keep source order, provenance and visibility', () => {
  const originalUser = {
    type: 'message', id: 'user-1', timestamp: '2026-11-05T12:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Explain this' }] },
  }
  const branch = {
    type: 'branch_summary', id: 'branch-1', fromId: 'old-branch',
    summary: 'Previous branch covered an earlier approach',
    timestamp: '2026-11-05T12:00:01.000Z',
  }
  const visible = {
    type: 'custom_message', id: 'custom-visible', customType: 'my-extension',
    display: true, content: 'Visible injected context',
  }
  const hidden = {
    type: 'custom_message', id: 'custom-hidden', customType: 'private-extension',
    display: false, content: 'Not shown in the Pi TUI',
  }
  const excluded = {
    type: 'context_edit', id: 'ctx-omitted', targetId: 'user-1', replacement: null,
  }
  const replaced = {
    type: 'context_edit', id: 'ctx-replaced', targetId: 'user-1',
    replacement: { content: 'Updated model context' },
  }
  const bash = {
    type: 'message', id: 'bash-1',
    message: { role: 'bashExecution', command: 'echo hello',
      output: 'hello', exitCode: 0, cancelled: false, truncated: false },
  }
  const items = projectLiveSnapshotEntries([
    originalUser, branch, visible, hidden, excluded, replaced, bash,
  ])
  assert.deepEqual(items.map(item => item.kind), [
    'message', 'native', 'native', 'native', 'native', 'native', 'native',
  ])
  assert.deepEqual(items.map(item => item.id), [
    'user-1', 'native-branch-summary:branch-1', 'native-custom-message:custom-visible',
    'native-custom-message:custom-hidden', 'native-context-edit:ctx-omitted',
    'native-context-edit:ctx-replaced', 'native-bash:bash-1',
  ])
  assert.ok(items[1]?.kind === 'native')
  assert.equal(items[1].preview, branch.summary)
  assert.equal(items[1].source.fromId, 'old-branch')
  assert.ok(items[2]?.kind === 'native')
  assert.match(items[2].preview, /Visible injected context/)
  assert.ok(items[3]?.kind === 'native')
  assert.equal(items[3].preview, 'private-extension')
  assert.equal(items[3].source.display, false)
  assert.ok(items[4]?.kind === 'native')
  assert.equal(items[4].source.replacement, null)
  assert.ok(items[5]?.kind === 'native')
  assert.deepEqual(items[5].source.replacement, { content: 'Updated model context' })
  assert.ok(items[6]?.kind === 'native')
  assert.equal(items[6].nativeType, 'bashExecution')
  assert.equal(items[6].preview, 'echo hello')
  assert.equal(projectLiveTaskRounds(items).length, 1)
  assert.equal(projectLiveTaskRounds(items)[0]?.model.toolCount, 0)
})

test('Hidden/unknown Pi extension display state never promotes its content to a visible answer', () => {
  const items = projectLiveSnapshotEntries([
    { type: 'custom_message', id: 'hidden', customType: 'ext',
      content: 'hidden payload', display: false },
    { type: 'custom_message', id: 'unspecified', customType: 'ext',
      content: 'undetermined payload' },
    { type: 'context_edit', id: 'omitted', targetId: 'target', replacement: null },
  ])
  assert.equal(items.filter(item => item.kind === 'message').length, 0)
  for (const item of items) {
    assert.ok(item.kind === 'native')
    assert.doesNotMatch(item.preview, /hidden payload|undetermined payload/)
  }
  assert.equal(items[2]?.id, 'native-context-edit:omitted')
})

test('Pi composer stage follows native retry/compaction start and end without timeout guesses', () => {
  const user = { id: 'u', kind: 'message' as const, role: 'user' as const, text: 'repair', streaming: false }
  let items = reduceLiveTaskEvent([user], event(1, { type: 'status', status: 'running',
    process: { operation: 'retry', phase: 'start', attempt: 1, maxAttempts: 3 },
  }))
  assert.equal(liveTaskResponseActivity(items, true), 'retrying')
  items = reduceLiveTaskEvent(items, event(2, { type: 'status', status: 'running',
    process: { operation: 'retry', phase: 'end', outcome: 'success' },
  }))
  assert.equal(liveTaskResponseActivity(items, true), 'processing')
  items = reduceLiveTaskEvent(items, event(3, { type: 'status', status: 'compacting',
    process: { operation: 'compaction', phase: 'start', reason: 'overflow' },
  }))
  assert.equal(liveTaskResponseActivity(items, true), 'compacting')
  items = reduceLiveTaskEvent(items, event(4, { type: 'status', status: 'ready',
    process: { operation: 'compaction', phase: 'end', outcome: 'success' },
  }))
  assert.equal(liveTaskResponseActivity(items, true), 'processing')
  assert.equal(liveTaskResponseActivity(items, false), null)
  // A provider without process events keeps the generic previous contract.
  assert.equal(liveTaskResponseActivity([user, {
    id: 'native', kind: 'native', nativeType: 'branch_summary',
    preview: 'summary', source: { type: 'branch_summary' },
  }], true), 'processing')
})

test('Pi native model usage keeps only source-recorded values and catalog cost provenance', () => {
  assert.deepEqual(sourceNativeUsageDetail({
    input: 120, output: 40, reasoning: 10,
    cacheRead: 25, cacheWrite: 5, totalTokens: 190,
    cost: { total: 0.00123 },
  }, 'assistant', { provider: 'anthropic', model: 'model-x' }), {
    origin: 'assistant', provider: 'anthropic', model: 'model-x',
    input: 120, output: 40, reasoning: 10,
    cacheRead: 25, cacheWrite: 5, totalTokens: 190,
    costTotal: 0.00123,
  })
  // Pi reasoning is already included in output; cache tokens must not be
  // added to totalTokens again, and a catalog cost is not provider-billed.
  assert.deepEqual(sourceNativeUsageDetail({
    output: 0, totalTokens: 0,
    cost: { total: 0.05, totalFromProvider: true },
  }, 'assistant', { model: 'model-z' }), {
    origin: 'assistant', model: 'model-z',
    output: 0, totalTokens: 0, costTotal: 0.05, costTotalFromProvider: true,
  })
  assert.equal(sourceNativeUsageDetail({
    input: -1, output: '5', cacheRead: null,
    cost: { total: Number.NaN },
  }, 'assistant', { model: 'name-only' }), undefined)
  assert.equal(sourceNativeUsageDetail(null, 'assistant', { model: 'name-only' }), undefined)
})

test('Pi assistant and independent usage entries are distinct native invocation facts', () => {
  const assistant = {
    type: 'message', id: 'assistant-1', timestamp: '2026-11-05T12:00:01.000Z',
    message: { role: 'assistant', provider: 'openai', model: 'gpt-x',
      content: [{ type: 'text', text: 'Done' }], stopReason: 'stop',
      usage: { input: 10, output: 6, cacheRead: 3, cacheWrite: 1,
        totalTokens: 20, cost: { total: 0.002, totalFromProvider: true } } },
  }
  const extra = {
    type: 'usage', id: 'extra-1', kind: 'cache_warm',
    provider: 'openai', model: 'gpt-x',
    usage: { input: 0, output: 0, cacheRead: 100, cacheWrite: 0,
      totalTokens: 100, cost: { total: 0.01 } },
  }
  const rows = projectLiveSnapshotEntries([
    { type: 'message', id: 'user-1', message: { role: 'user', content: 'test' } },
    assistant, extra,
  ])
  const usage = rows.filter(item => item.kind === 'usage')
  assert.equal(usage.length, 2)
  assert.equal(usage[0]?.id, 'native-usage:assistant-1')
  assert.equal(usage[1]?.id, 'native-usage:extra-1')
  assert.deepEqual(usage.map(item => item.kind === 'usage' ? item.details.totalTokens : undefined), [20, 100])
  assert.ok(usage[0]?.kind === 'usage')
  assert.deepEqual(usage[0].details, {
    origin: 'assistant', provider: 'openai', model: 'gpt-x',
    input: 10, output: 6, cacheRead: 3, cacheWrite: 1,
    totalTokens: 20, costTotal: 0.002, costTotalFromProvider: true,
  })
  assert.equal(usage[0].source, assistant)
  assert.ok(usage[1]?.kind === 'usage')
  assert.equal(usage[1].details.kind, 'cache_warm')
  assert.equal(usage[1].details.costTotalFromProvider, undefined)
  // Only two distinct calls are shown; no inferred aggregate for a partial window.
  assert.equal(projectLiveTaskRounds(rows)[0]?.model.toolCount, 0)
})

test('Pi native compaction, branch summary and nested tool usage stay independent', () => {
  const rows = projectLiveSnapshotEntries([
    { type: 'compaction', id: 'compaction-usage', summary: 'trimmed',
      firstKeptEntryId: 'a', tokensBefore: 5000,
      usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.003 } } },
    { type: 'branch_summary', id: 'branch-usage', summary: 'other path',
      usage: { input: 20, output: 3, totalTokens: 23 } },
    { type: 'message', id: 'tool-usage', message: { role: 'toolResult',
      toolCallId: 'tool-1', toolName: 'delegate', isError: false,
      content: [{ type: 'text', text: 'ok' }],
      usage: { input: 30, output: 4, totalTokens: 34 } } },
  ])
  assert.deepEqual(rows.filter(item => item.kind === 'usage')
    .map(item => item.kind === 'usage' ? item.details.origin : ''), [
      'compaction', 'branch_summary', 'toolResult',
    ])
  assert.equal(rows.find(item => item.kind === 'tool')?.kind, 'tool')
  assert.equal(rows.find(item => item.kind === 'event')?.kind, 'event')
  assert.equal(rows.find(item => item.kind === 'native')?.kind, 'native')
})

test('Pi native system prompt/tool loadout changes stay source-backed and collapsed preview is safe', () => {
  const first = {
    type: 'message', id: 'system-1', timestamp: '2026-11-05T12:00:00.000Z',
    message: { role: 'system', content: 'PRIVATE SYSTEM PROMPT',
      sections: { preamble: 'SECRET PREAMBLE', tools: '<tools>secret list</tools>', cwd: '/repo' },
      toolsAdded: [{ name: 'read', description: 'Read a file' }, { name: 'edit' }] },
  }
  const patch = {
    type: 'message', id: 'system-2', timestamp: '2026-11-05T12:01:00.000Z',
    message: { role: 'system', content: '',
      sections: { tools: null, skills: 'Updated skills' },
      toolsRemoved: [{ name: 'edit' }] },
  }
  const rows = projectLiveSnapshotEntries([first, patch, {
    type: 'message', id: 'user-1', message: { role: 'user', content: 'hello' },
  }])
  assert.deepEqual(rows.map(item => item.kind), ['native', 'native', 'message'])
  assert.equal(rows[0]?.id, 'native-system:system-1')
  assert.ok(rows[0]?.kind === 'native')
  assert.equal(rows[0].nativeType, 'system')
  assert.match(rows[0].preview, /sections: preamble, tools, cwd/)
  assert.match(rows[0].preview, /\+ read, edit/)
  assert.doesNotMatch(rows[0].preview, /PRIVATE SYSTEM PROMPT|SECRET PREAMBLE|secret list/)
  assert.equal(rows[0].source, first)
  assert.ok(rows[1]?.kind === 'native')
  assert.equal(rows[1].preview, 'sections: tools, skills · − edit')
  assert.equal(rows[1].source, patch)
  assert.equal(rows.some(item => item.kind === 'message' && item.role === 'assistant'), false)
  // Distinct historical declarations are never collapsed into a guessed
  // "effective current prompt" from a possibly paginated native window.
  assert.equal(rows.filter(item => item.kind === 'native').length, 2)
})

test('Pi native system records without sections retain exact source without a fabricated tool list', () => {
  const record = { type: 'message', id: 'system-legacy',
    message: { role: 'system', content: 'Older system prompt' } }
  const rows = projectLiveSnapshotEntries([record])
  assert.equal(rows.length, 1)
  const system = rows[0]
  assert.ok(system?.kind === 'native')
  assert.equal(system.nativeType, 'system')
  assert.equal(system.preview, '')
  assert.equal(system.source, record)
})

test('summary retries share the native process timeline and never imply successful completion', () => {
  const scheduled = reduceLiveTaskEvent([], event(1, {
    type: 'status', status: 'running',
    process: { operation: 'retry', phase: 'start', attempt: 1, maxAttempts: 3 },
  }))
  assert.equal(liveTaskResponseActivity(scheduled, true), 'retrying')
  const attempt = reduceLiveTaskEvent(scheduled, event(2, {
    type: 'status', status: 'running',
    process: { operation: 'retry', phase: 'start', retrySource: 'branchSummary' },
  }))
  assert.equal(attempt[1]?.kind === 'event' ? attempt[1].process.retrySource : undefined, 'branchSummary')
  const finished = reduceLiveTaskEvent(attempt, event(3, {
    type: 'status', status: 'running',
    process: { operation: 'retry', phase: 'end' },
  }))
  assert.equal(liveTaskResponseActivity(finished, true), 'processing')
  assert.equal(finished[2]?.kind === 'event' ? finished[2].process.outcome : undefined, undefined)
})

test('Pi official subagent details survive native Live projection as one tool call', () => {
  const details = { mode: 'parallel', results: [
    { agent: 'scout', status: 'completed', messages: [{ role: 'assistant',
      content: [{ type: 'text', text: 'found matching files' }] }] },
    { agent: 'worker', status: 'failed', errorMessage: 'tool failed', messages: [] },
  ] }
  const projected = projectLiveSnapshotEntries([
    { type: 'message', id: 'assistant-subagent', message: {
      role: 'assistant', content: [{ type: 'toolCall',
        id: 'dispatch-1', name: 'subagent', arguments: { tasks: ['scout', 'worker'] } }],
    } },
    { type: 'message', id: 'tool-result-subagent', message: {
      role: 'toolResult', toolCallId: 'dispatch-1', toolName: 'subagent', isError: true,
      content: [{ type: 'text', text: 'one task failed' }], details,
    } },
  ])
  const tools = projected.filter(item => item.kind === 'tool')
  assert.equal(tools.length, 1)
  assert.deepEqual(tools[0]?.kind === 'tool' ? tools[0].resultDetails : undefined, details)
  assert.equal(tools[0]?.kind === 'tool' ? tools[0].status : undefined, 'error')
})
