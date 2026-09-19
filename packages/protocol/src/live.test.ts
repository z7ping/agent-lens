import assert from 'node:assert/strict'
import test from 'node:test'
import { liveMessagePlainTextDto, parseLiveEventDto, parseLiveMessageInputDto, parseLiveModelControlDto, parseLiveThinkingControlDto } from './live'

test('Live protocol preserves Runtime thinking values, order, and duplicates without normalization', () => {
  const parsed = parseLiveThinkingControlDto({
    capability: 'thinking-control',
    value: 'max',
    options: [
      { value: 'off', label: 'off' },
      { value: 'minimal', label: 'minimal' },
      { value: 'xhigh', label: 'xhigh' },
      { value: 'max', label: 'max' },
      { value: 'max', label: 'max duplicate' },
    ],
  })

  assert.ok(parsed)
  assert.equal(parsed.value, 'max')
  assert.deepEqual(parsed.options.map(option => option.value), ['off', 'minimal', 'xhigh', 'max', 'max'])
})

test('Live protocol rejects incomplete or mismatched thinking control descriptions', () => {
  assert.equal(parseLiveThinkingControlDto({
    capability: 'thinking-control',
    value: 'xhigh',
    options: [{ value: 'max' }],
  }), null)
  assert.equal(parseLiveThinkingControlDto({
    capability: 'thinking-control',
    value: 'xhigh',
    options: [],
  }), null)
  assert.equal(parseLiveThinkingControlDto({
    capability: 'model-switching',
    value: 'xhigh',
    options: [{ value: 'xhigh' }],
  }), null)
})


test('Live protocol preserves structured large text until an adapter transform boundary', () => {
  const message = parseLiveMessageInputDto({
    parts: [
      { type: 'text', text: '分析日志' },
      { type: 'large-text', text: 'line 1\nline 2', lineCount: 2, charCount: 13 },
    ],
  })

  assert.deepEqual(message.parts[1], {
    type: 'large-text',
    text: 'line 1\nline 2',
    lineCount: 2,
    charCount: 13,
  })
  assert.equal(liveMessagePlainTextDto(message), '分析日志\n\nline 1\nline 2')
})

test('Live protocol rejects invalid attachment metadata and refuses implicit attachment flattening', () => {
  assert.throws(
    () => parseLiveMessageInputDto({ parts: [{ type: 'image', attachmentId: '' }] }),
    /requires attachmentId/,
  )
  assert.throws(
    () => liveMessagePlainTextDto(parseLiveMessageInputDto({
      parts: [{ type: 'image', attachmentId: 'image-1', mimeType: 'image\/png' }],
    })),
    /requires adapter transformation/,
  )
})


test('Live protocol validates normalized streaming events without vendor payload knowledge', () => {
  assert.deepEqual(parseLiveEventDto({
    type: 'tool.end',
    callId: 'call-1',
    name: 'terminal',
    status: 'success',
    output: 'ok',
    durationMs: 250,
  }), {
    type: 'tool.end',
    callId: 'call-1',
    name: 'terminal',
    status: 'success',
    output: 'ok',
    durationMs: 250,
  })
  assert.deepEqual(parseLiveEventDto({
    type: 'completed',
    status: 'interrupted',
  }), {
    type: 'completed',
    status: 'interrupted',
  })
  assert.deepEqual(parseLiveEventDto({
    type: 'queue.update',
    steering: ['先检查测试'],
    followUp: ['完成后总结'],
  }), {
    type: 'queue.update',
    steering: ['先检查测试'],
    followUp: ['完成后总结'],
  })
  assert.equal(parseLiveEventDto({ type: 'queue.update', steering: ['ok'], followUp: [1] }), null)
  assert.equal(parseLiveEventDto({ type: 'completed', status: 'unknown' }), null)
})


test('Live protocol preserves opaque model values without vendor fields', () => {
  const parsed = parseLiveModelControlDto({
    capability: 'model-switching',
    value: 'opaque:model-a',
    options: [
      { value: 'opaque:model-a', label: 'Model A', description: 'Provider A' },
      { value: 'opaque:model-b', label: 'Model B' },
    ],
  })
  assert.ok(parsed)
  assert.equal(parsed.value, 'opaque:model-a')
  assert.deepEqual(parsed.options.map(option => option.value), ['opaque:model-a', 'opaque:model-b'])
})

test('Live protocol accepts Runtime Disclosure invalidation events', () => {
  assert.deepEqual(parseLiveEventDto({
    type: 'runtime-disclosure.changed',
  }), {
    type: 'runtime-disclosure.changed',
  })
})

test('Live protocol validates control.changed events', () => {
  assert.deepEqual(parseLiveEventDto({
    type: 'control.changed',
    control: 'model',
  }), {
    type: 'control.changed',
    control: 'model',
  })
  assert.deepEqual(parseLiveEventDto({
    type: 'control.changed',
    control: 'thinking',
  }), {
    type: 'control.changed',
    control: 'thinking',
  })
  assert.equal(parseLiveEventDto({ type: 'control.changed', control: 'unknown' }), null)
})

test('Live protocol validates and bounds title.update events', () => {
  assert.deepEqual(parseLiveEventDto({
    type: 'title.update',
    title: '  Live task title  ',
  }), {
    type: 'title.update',
    title: 'Live task title',
  })
  assert.equal(parseLiveEventDto({ type: 'title.update', title: '   ' }), null)
  assert.equal(
    (parseLiveEventDto({ type: 'title.update', title: 'x'.repeat(300) }) as { title?: string } | null)?.title?.length,
    240,
  )
})

test('Live protocol validates normalized extension UI requests', () => {
  assert.deepEqual(parseLiveEventDto({
    type: 'ui.request',
    requestId: 'request-1',
    method: 'select',
    title: 'Choose',
    options: ['A', 'B'],
  }), {
    type: 'ui.request',
    requestId: 'request-1',
    method: 'select',
    title: 'Choose',
    options: ['A', 'B'],
  })
  assert.equal(parseLiveEventDto({ type: 'ui.request', requestId: '', method: 'confirm' }), null)
  assert.equal(parseLiveEventDto({ type: 'ui.request', requestId: 'x', method: 'unknown' }), null)
})


test('Live session tree DTO stays agent-neutral and flat', () => {
  const tree = {
    activeLeafId: 'entry-2',
    nodes: [
      {
        id: 'entry-1',
        parentId: null,
        type: 'message' as const,
        role: 'user' as const,
        preview: 'hello',
        activePath: true,
        childCount: 1,
      },
      {
        id: 'entry-2',
        parentId: 'entry-1',
        type: 'branch-summary' as const,
        summary: 'summary',
        activePath: true,
        childCount: 0,
      },
    ],
    branchPointIds: [],
    capabilities: {
      switchBranch: true,
      fork: true,
      clone: false,
      branchSummary: true,
    },
  }

  assert.deepEqual(tree.nodes.map(node => [node.id, node.parentId, node.type]), [
    ['entry-1', null, 'message'],
    ['entry-2', 'entry-1', 'branch-summary'],
  ])
  assert.equal(Object.hasOwn(tree.nodes[0]!, 'entry'), false)
})
