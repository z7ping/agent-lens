import assert from 'node:assert/strict'
import test from 'node:test'
import { appendPiLiveDelta, finishPiLiveContentBlock, finishPiLiveTool, markPiLiveItemsRunning, reconcilePiLiveItems, settlePiLiveItems, startPiLiveContentBlock, startPiLiveTool } from './pi-live-current'
import type { PiLiveHistoryItem } from './pi-live-history'

test('Pi Live 按 SSE 到达顺序保留 thinking / text / tool 的交错块', () => {
  let items: PiLiveHistoryItem[] = []
  items = appendPiLiveDelta(items, 'thinking', '先分析', { messageEpoch: 1, contentIndex: 0 })
  items = appendPiLiveDelta(items, 'text', '先说明一段', { messageEpoch: 1, contentIndex: 1 })
  items = startPiLiveTool(items, { callId: 'tool-1', name: 'bash', summary: 'git status', contentIndex: 2 })
  items = finishPiLiveTool(items, 'tool-1', 'success', 'clean', 220)
  items = appendPiLiveDelta(items, 'text', '工具后继续', { messageEpoch: 1, contentIndex: 3 })
  items = appendPiLiveDelta(items, 'thinking', '再确认', { messageEpoch: 1, contentIndex: 4 })
  items = appendPiLiveDelta(items, 'text', '最终结果', { messageEpoch: 1, contentIndex: 5 })

  assert.deepEqual(items.map(item => item.kind), ['thinking', 'message', 'tool', 'message', 'thinking', 'message'])
  assert.deepEqual(items.filter(item => item.kind === 'message').map(item => item.text), ['先说明一段', '工具后继续', '最终结果'])
  const tool = items.find(item => item.kind === 'tool')
  assert.ok(tool && tool.kind === 'tool')
  assert.equal(tool.status, 'success')
  assert.equal(tool.contentIndex, 2)
})

test('Pi Live 在 *_start 就占位，后续交错 delta 不会越过工具块', () => {
  let items: PiLiveHistoryItem[] = []
  items = startPiLiveContentBlock(items, 'text', { messageEpoch: 1, contentIndex: 0 })
  const textId = items[0]!.id
  items = startPiLiveTool(items, { callId: 'tool-1', name: 'bash', summary: '', contentIndex: 1 })
  items = appendPiLiveDelta(items, 'text', '工具前正文继续到达', { messageEpoch: 1, contentIndex: 0 })

  assert.deepEqual(items.map(item => item.kind), ['message', 'tool'])
  assert.equal(items[0]!.id, textId)
  assert.equal(items[0]!.kind === 'message' ? items[0].text : '', '工具前正文继续到达')
})

test('Pi Live *_end 用权威完整内容原位结算 block', () => {
  let items: PiLiveHistoryItem[] = []
  items = startPiLiveContentBlock(items, 'thinking', { messageEpoch: 1, contentIndex: 0 }, '完整思考')
  const id = items[0]!.id
  items = finishPiLiveContentBlock(items, 'thinking', '完整思考', { messageEpoch: 1, contentIndex: 0 })

  assert.equal(items.length, 1)
  assert.equal(items[0]!.id, id)
  assert.equal(items[0]!.kind === 'thinking' ? items[0].text : '', '完整思考')
  assert.equal(items[0]!.kind === 'thinking' ? items[0].state : undefined, 'settled')
})

test('Pi Live 同一 contentIndex 的 delta 原位增长，即使中途出现其他块', () => {
  let items: PiLiveHistoryItem[] = []
  items = appendPiLiveDelta(items, 'text', '前', { messageEpoch: 3, contentIndex: 0 })
  const textId = items[0]!.id
  items = startPiLiveTool(items, { callId: 'tool-1', name: 'bash', summary: '' })
  items = appendPiLiveDelta(items, 'text', '后', { messageEpoch: 3, contentIndex: 0 })

  assert.equal(items.length, 2)
  assert.equal(items[0]!.id, textId)
  assert.equal(items[0]!.kind === 'message' ? items[0].text : '', '前后')
  assert.equal(items[1]!.kind, 'tool')
})

test('Pi Live 相邻同类型但不同 contentIndex 不会被合并', () => {
  let items: PiLiveHistoryItem[] = []
  items = appendPiLiveDelta(items, 'text', '第一块', { messageEpoch: 2, contentIndex: 0 })
  items = appendPiLiveDelta(items, 'text', '第二块', { messageEpoch: 2, contentIndex: 1 })
  items = appendPiLiveDelta(items, 'thinking', '思考一', { messageEpoch: 2, contentIndex: 2 })
  items = appendPiLiveDelta(items, 'thinking', '思考二', { messageEpoch: 2, contentIndex: 3 })

  assert.deepEqual(items.map(item => item.kind), ['message', 'message', 'thinking', 'thinking'])
  assert.deepEqual(items.map(item => item.contentIndex), [0, 1, 2, 3])
  assert.notEqual(items[0]!.id, items[1]!.id)
  assert.notEqual(items[2]!.id, items[3]!.id)
})

test('Pi Live tool call 先占位，执行事件只原位补齐而不改变顺序', () => {
  let items: PiLiveHistoryItem[] = []
  items = appendPiLiveDelta(items, 'thinking', '分析', { messageEpoch: 1, contentIndex: 0 })
  items = startPiLiveTool(items, { callId: 'tool-1', name: 'bash', summary: '', contentIndex: 1 })
  const toolId = items[1]!.id
  items = appendPiLiveDelta(items, 'text', '后续正文', { messageEpoch: 1, contentIndex: 2 })
  items = startPiLiveTool(items, { callId: 'tool-1', name: 'bash', summary: 'git status', startedAtMs: 100 })
  items = finishPiLiveTool(items, 'tool-1', 'success', 'clean', 250)

  assert.deepEqual(items.map(item => item.kind), ['thinking', 'tool', 'message'])
  const tool = items[1]
  assert.ok(tool?.kind === 'tool')
  assert.equal(tool.id, toolId)
  assert.equal(tool.summary, 'git status')
  assert.equal(tool.durationMs, 150)
})

test('Pi Live settled 对账保留已渲染 block 的 id 和相对顺序', () => {
  let live: PiLiveHistoryItem[] = []
  live = appendPiLiveDelta(live, 'thinking', '思考', { messageEpoch: 1, contentIndex: 0 })
  live = startPiLiveTool(live, { callId: 'tool-1', name: 'bash', summary: 'git status', startedAtMs: 100, contentIndex: 1 })
  live = finishPiLiveTool(live, 'tool-1', 'success', 'clean', 200)
  live = appendPiLiveDelta(live, 'text', '完成', { messageEpoch: 1, contentIndex: 2 })
  const liveIds = live.map(item => item.id)

  const persisted: PiLiveHistoryItem[] = [
    { id: 'native-thinking', kind: 'thinking', text: '思考', at: '2026-09-07T00:00:00.000Z', contentIndex: 0 },
    { id: 'native-tool', kind: 'tool', callId: 'tool-1', name: 'bash', summary: 'git status', output: 'clean', status: 'success', at: '2026-09-07T00:00:01.000Z', durationMs: 100, contentIndex: 1 },
    { id: 'native-text', kind: 'message', role: 'assistant', text: '完成', at: '2026-09-07T00:00:02.000Z', contentIndex: 2 },
    { id: 'native-stop', kind: 'lifecycle', event: 'assistant.stop', label: 'Pi 响应结束', detail: 'stop', at: '2026-09-07T00:00:02.000Z' },
  ]

  const settled = reconcilePiLiveItems(live, persisted)
  assert.deepEqual(settled.map(item => item.kind), ['thinking', 'tool', 'message', 'lifecycle'])
  assert.deepEqual(settled.slice(0, 3).map(item => item.id), liveIds)
  assert.equal(settled[0]!.kind === 'thinking' ? settled[0].state : undefined, 'settled')
  assert.equal(settled[2]!.kind === 'message' ? settled[2].state : undefined, 'settled')
  assert.deepEqual(settled.slice(0, 3).map(item => item.contentIndex), [0, 1, 2])
})

test('Pi Live settled 使用 contentIndex 避免同类缺失块错配', () => {
  const live: PiLiveHistoryItem[] = [
    { id: 'live-thinking-0', kind: 'thinking', text: '分析', at: '', state: 'running', contentIndex: 0 },
    { id: 'live-text-2', kind: 'message', role: 'assistant', text: '最终', at: '', state: 'running', contentIndex: 2 },
  ]
  const persisted: PiLiveHistoryItem[] = [
    { id: 'native-thinking-0', kind: 'thinking', text: '分析', at: '', contentIndex: 0 },
    { id: 'native-text-1', kind: 'message', role: 'assistant', text: '中间说明', at: '', contentIndex: 1 },
    { id: 'native-text-2', kind: 'message', role: 'assistant', text: '最终', at: '', contentIndex: 2 },
  ]

  const settled = reconcilePiLiveItems(live, persisted)
  assert.deepEqual(settled.map(item => item.id), ['live-thinking-0', 'native-text-1', 'live-text-2'])
  assert.equal(settled[2]!.kind === 'message' ? settled[2].text : '', '最终')
})

test('Pi Live settled 不会为了 Snapshot 的冲突顺序移动已经显示的块', () => {
  let live: PiLiveHistoryItem[] = []
  live = appendPiLiveDelta(live, 'thinking', '思考')
  live = appendPiLiveDelta(live, 'text', '正文')
  const ids = live.map(item => item.id)
  const persisted: PiLiveHistoryItem[] = [
    { id: 'native-text', kind: 'message', role: 'assistant', text: '正文', at: '' },
    { id: 'native-thinking', kind: 'thinking', text: '思考', at: '' },
  ]

  assert.deepEqual(reconcilePiLiveItems(live, persisted).map(item => item.id), ids)
})

test('Pi Live streaming Snapshot 只把最后一个未完成 assistant 段标记为 running', () => {
  const restored = markPiLiveItemsRunning([
    { id: 'old-thinking', kind: 'thinking', text: '前一段思考', at: '', contentIndex: 0 },
    { id: 'old-tool', kind: 'tool', callId: 'old-tool', name: 'bash', summary: '', output: '', status: 'unknown', at: '', contentIndex: 1 },
    { id: 'old-text', kind: 'message', role: 'assistant', text: '前一段正文', at: '', contentIndex: 2 },
    { id: 'old-stop', kind: 'lifecycle', event: 'assistant.stop', label: 'Pi 响应结束', detail: 'toolUse', at: '' },
    { id: 'tool', kind: 'tool', callId: 'tool-1', name: 'bash', summary: '', output: '', status: 'unknown', at: '', contentIndex: 3 },
    { id: 'current-thinking', kind: 'thinking', text: '当前思考', at: '', contentIndex: 0 },
    { id: 'current-text', kind: 'message', role: 'assistant', text: '当前部分正文', at: '', contentIndex: 1 },
  ])

  assert.equal(restored[0]!.kind === 'thinking' ? restored[0].state : undefined, undefined)
  assert.equal(restored[1]!.kind === 'tool' ? restored[1].status : undefined, 'unknown')
  assert.equal(restored[2]!.kind === 'message' ? restored[2].state : undefined, undefined)
  assert.equal(restored[4]!.kind === 'tool' ? restored[4].status : undefined, 'running')
  assert.equal(restored[5]!.kind === 'thinking' ? restored[5].state : undefined, 'running')
  assert.equal(restored[6]!.kind === 'message' ? restored[6].state : undefined, 'running')
})

test('Pi Live SSE 重连后继续写入 Snapshot 的 running block 而不创建重复正文', () => {
  let restored = markPiLiveItemsRunning([
    { id: 'native-thinking', kind: 'thinking', text: '分析', at: '', contentIndex: 0 },
    { id: 'native-text', kind: 'message', role: 'assistant', text: '已经输出', at: '', contentIndex: 1 },
  ])
  const textId = restored[1]!.id

  restored = appendPiLiveDelta(restored, 'text', '，继续', { messageEpoch: 99, contentIndex: 1 })

  assert.equal(restored.length, 2)
  assert.equal(restored[1]!.id, textId)
  assert.equal(restored[1]!.kind === 'message' ? restored[1].text : '', '已经输出，继续')
})

test('Pi Live 新 assistant 段不会续写已 settled 的相同 contentIndex', () => {
  const previous: PiLiveHistoryItem[] = [
    { id: 'old-text', kind: 'message', role: 'assistant', text: '前一段', at: '', state: 'settled', contentIndex: 0 },
  ]
  const next = appendPiLiveDelta(previous, 'text', '新一段', { messageEpoch: 2, contentIndex: 0 })

  assert.equal(next.length, 2)
  assert.equal(next[0]!.id, 'old-text')
  assert.notEqual(next[1]!.id, 'old-text')
  assert.equal(next[1]!.kind === 'message' ? next[1].text : '', '新一段')
})

test('Pi Live Abort 本地结算只改变状态，不删除或重排已有块', () => {
  const live: PiLiveHistoryItem[] = [
    { id: 'thinking', kind: 'thinking', text: '处理中', at: '', state: 'running', contentIndex: 0 },
    { id: 'tool', kind: 'tool', callId: 'tool-1', name: 'bash', summary: '', output: '', status: 'running', at: '', contentIndex: 1 },
    { id: 'text', kind: 'message', role: 'assistant', text: '部分输出', at: '', state: 'running', contentIndex: 2 },
  ]
  const ids = live.map(item => item.id)
  const settled = settlePiLiveItems(live)

  assert.deepEqual(settled.map(item => item.id), ids)
  assert.deepEqual(settled.map(item => item.kind), ['thinking', 'tool', 'message'])
  assert.equal(settled[0]!.kind === 'thinking' ? settled[0].state : undefined, 'settled')
  assert.equal(settled[1]!.kind === 'tool' ? settled[1].status : undefined, 'unknown')
  assert.equal(settled[2]!.kind === 'message' ? settled[2].state : undefined, 'settled')
  assert.deepEqual(reconcilePiLiveItems(live, []), settled)
})
