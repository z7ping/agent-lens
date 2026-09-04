import assert from 'node:assert/strict'
import test from 'node:test'
import type { PiLiveSnapshotDto } from '@agent-lens/protocol'
import { mergePiLiveObservedThinking, omitPiLivePromptMessages, projectPiLiveHistory, type PiLiveHistoryItem } from './pi-live-history'

function snapshot(entries: PiLiveSnapshotDto['entries']): PiLiveSnapshotDto {
  return {
    state: {
    runtimeSessionId: 'runtime-1', status: 'ready',
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
    },
    entries,
    leafId: null,
  }
}

test('Pi Live 完成态只保留乐观用户消息并移除分片中的所有重复副本', () => {
  const items: PiLiveHistoryItem[] = [
    { id: 'user-1', kind: 'message', role: 'user', text: '执行检查', at: '' },
    { id: 'assistant-1', kind: 'message', role: 'assistant', text: '执行检查', at: '' },
    { id: 'user-2', kind: 'message', role: 'user', text: ' 执行检查 ', at: '' },
    { id: 'tool-1', kind: 'tool', callId: 'call-1', name: 'bash', summary: '', output: '', status: 'success', at: '' },
  ]

  assert.deepEqual(omitPiLivePromptMessages(items, '执行检查').map(item => item.id), ['assistant-1', 'tool-1'])
  assert.equal(omitPiLivePromptMessages(items).length, items.length)
})

test('Pi Live 用实时观察补齐完成态缺失的思考且不覆盖原生思考', () => {
  const base: PiLiveHistoryItem[] = [
    { id: 'user-1', kind: 'message', role: 'user', text: '检查', at: '' },
    { id: 'assistant-1', kind: 'message', role: 'assistant', text: '完成', at: '' },
  ]
  const observed = [{ ordinal: 1, text: '实时思考', at: '2026-09-03T00:00:00.000Z' }]
  assert.deepEqual(mergePiLiveObservedThinking(base, observed).map(item => item.kind), ['message', 'thinking', 'message'])

  const native = [base[0]!, { id: 'native-thinking', kind: 'thinking' as const, text: '原生思考', at: '' }, base[1]!]
  assert.equal(mergePiLiveObservedThinking(native, observed).filter(item => item.kind === 'thinking').length, 1)
})

test('Pi Live persisted history preserves message, thinking, tool and lifecycle facts', () => {
  const items = projectPiLiveHistory(snapshot([
    {
      type: 'message',
      id: 'user-1',
      timestamp: '2026-08-30T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '检查仓库' }] },
    },
    {
      type: 'message',
      id: 'assistant-1',
      timestamp: '2026-08-30T00:00:01.000Z',
      message: {
        role: 'assistant',
        provider: 'test',
        model: 'model-1',
        stopReason: 'toolUse',
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { total: 0.002 } },
        content: [
          { type: 'thinking', thinking: '先确认状态' },
          { type: 'text', text: '我先检查。' },
          { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'git status' } },
        ],
      },
    },
    {
      type: 'message',
      id: 'result-1',
      timestamp: '2026-08-30T00:00:02.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'bash',
        isError: false,
        content: [{ type: 'text', text: 'clean' }],
      },
    },
    { type: 'model_change', id: 'model-1', provider: 'test', modelId: 'model-2' },
    { type: 'thinking_level_change', id: 'thinking-1', level: 'high' },
    { type: 'compaction', id: 'compact-1', tokensBefore: 1234, summary: 'summary' },
  ]))

  assert.deepEqual(items.map(item => item.kind), [
    'message',
    'message',
    'lifecycle',
    'thinking',
    'tool',
    'usage',
    'lifecycle',
    'lifecycle',
    'lifecycle',
  ])

  const assistant = items.find(item => item.kind === 'message' && item.role === 'assistant')
  assert.ok(assistant && assistant.kind === 'message')
  assert.equal(assistant.text, '我先检查。')
  assert.doesNotMatch(assistant.text, /先确认状态/)

  const thinking = items.find(item => item.kind === 'thinking')
  assert.ok(thinking && thinking.kind === 'thinking')
  assert.equal(thinking.text, '先确认状态')

  const tool = items.find(item => item.kind === 'tool')
  assert.ok(tool && tool.kind === 'tool')
  assert.equal(tool.callId, 'tool-1')
  assert.equal(tool.name, 'bash')
  assert.equal(tool.status, 'success')
  assert.equal(tool.output, 'clean')
  assert.equal(tool.durationMs, 1000)

  assert.ok(items.some(item => item.kind === 'lifecycle' && item.event === 'model.changed'))
  assert.ok(items.some(item => item.kind === 'lifecycle' && item.event === 'thinking.level.changed'))
  assert.ok(items.some(item => item.kind === 'lifecycle' && item.event === 'context.compaction'))
  assert.ok(items.some(item => item.kind === 'lifecycle' && item.event === 'assistant.stop'))
  const usage = items.find(item => item.kind === 'usage')
  assert.ok(usage && usage.kind === 'usage')
  assert.equal(usage.usage.totalTokens, 18)
  assert.equal(usage.usage.cost?.total, 0.002)
})

test('Pi Live persisted history keeps orphan tool results instead of dropping facts', () => {
  const items = projectPiLiveHistory(snapshot([
    {
      type: 'message',
      id: 'result-only',
      message: {
        role: 'toolResult',
        toolCallId: 'missing-call',
        toolName: 'read',
        isError: true,
        content: [{ type: 'text', text: 'not found' }],
      },
    },
  ]))

  assert.equal(items.length, 1)
  const item = items[0]
  assert.ok(item && item.kind === 'tool')
  assert.equal(item.callId, 'missing-call')
  assert.equal(item.status, 'error')
  assert.equal(item.output, 'not found')
  assert.match(item.summary, /保留原生 Tool Result 事实/)
})

test('Pi Live 将用户中止明确显示为取消而不误报响应错误', () => {
  const items = projectPiLiveHistory(snapshot([
    {
      type: 'message',
      id: 'assistant-aborted',
      timestamp: '2026-09-04T00:00:00.000Z',
      message: {
        role: 'assistant',
        stopReason: 'aborted',
        errorMessage: 'Request aborted',
        content: [],
      },
    },
  ]))

  const lifecycle = items.find(item => item.kind === 'lifecycle')
  assert.ok(lifecycle && lifecycle.kind === 'lifecycle')
  assert.equal(lifecycle.event, 'assistant.cancelled')
  assert.equal(lifecycle.label, '用户已取消 Pi 响应')
  assert.equal(lifecycle.detail, '')
})

test('Pi Live 仍将真实 Pi 错误显示为响应错误', () => {
  const items = projectPiLiveHistory(snapshot([
    {
      type: 'message',
      id: 'assistant-error',
      timestamp: '2026-09-04T00:00:00.000Z',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'Provider unavailable',
        content: [],
      },
    },
  ]))

  const lifecycle = items.find(item => item.kind === 'lifecycle')
  assert.ok(lifecycle && lifecycle.kind === 'lifecycle')
  assert.equal(lifecycle.event, 'assistant.error')
  assert.equal(lifecycle.label, 'Pi 响应错误')
  assert.equal(lifecycle.detail, 'error · Provider unavailable')
})
