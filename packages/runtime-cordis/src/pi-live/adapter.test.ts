import { Buffer } from 'node:buffer'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveAttachmentService } from '@agent-lens/core'
import { normalizePiLiveEvent, PiLiveAdapter } from './adapter'
import type { PiLiveImageInput, PiLiveRuntimeState, PiLiveService } from './types'

function attachmentService(overrides: Partial<LiveAttachmentService> = {}): LiveAttachmentService {
  return {
    put: async () => { throw new Error('not used') },
    get: async () => null,
    remove: async () => {},
    dispose: async () => {},
    ...overrides,
  }
}

const readyState: PiLiveRuntimeState = {
  runtimeSessionId: 'runtime-1',
  status: 'ready',
  thinkingLevel: 'xhigh',
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
}

test('Pi Live Adapter maps task summary into generic title.update', () => {
  assert.deepEqual(normalizePiLiveEvent({
    type: 'task_summary',
    taskSummary: '修复 Live 会话恢复',
  }), {
    type: 'title.update',
    title: '修复 Live 会话恢复',
  })
  assert.equal(normalizePiLiveEvent({ type: 'task_summary', taskSummary: '   ' }), undefined)
})

test('Pi Live Adapter exposes thinking-control only through Runtime-provided opaque values', async () => {
  const changes: string[] = []
  let thinking = {
    capability: 'thinking-control' as const,
    value: 'xhigh',
    options: ['off', 'minimal', 'xhigh', 'max'].map(value => ({ value, label: value })),
  }
  const service = {
    controls: async () => ({ models: [], thinking }),
    setThinkingLevel: async (_runtimeSessionId: string, value: string) => {
      changes.push(value)
      thinking = { ...thinking, value }
      return { ...readyState, thinkingLevel: value }
    },
  } as unknown as PiLiveService

  const adapter = new PiLiveAdapter(service, attachmentService())
  assert.equal(adapter.capabilities.has('thinking-control'), true)
  assert.deepEqual((await adapter.thinkingControl('runtime-1'))?.options.map(option => option.value), [
    'off',
    'minimal',
    'xhigh',
    'max',
  ])

  const changed = await adapter.setThinkingControl('runtime-1', 'max')
  assert.equal(changed.thinkingLevel, 'max')
  assert.deepEqual(changes, ['max'])

  await assert.rejects(() => adapter.setThinkingControl('runtime-1', 'high'), /does not offer value/)
})

test('Pi Live Adapter does not expose an invalid Runtime thinking-control description', async () => {
  const service = {
    controls: async () => ({
      models: [],
      thinking: {
        capability: 'thinking-control',
        value: 'xhigh',
        options: [{ value: 'max' }],
      },
    }),
  } as unknown as PiLiveService

  const adapter = new PiLiveAdapter(service, attachmentService())
  assert.equal(await adapter.thinkingControl('runtime-1'), null)
})

test('Pi Live Adapter accepts unified text and large-text messages without leaking Pi-specific markers', async () => {
  const prompts: string[] = []
  const service = {
    prompt: async (_runtimeSessionId: string, value: string) => { prompts.push(value) },
    steer: async () => {},
    followUp: async () => {},
  } as unknown as PiLiveService

  const adapter = new PiLiveAdapter(service, attachmentService())
  assert.equal(adapter.inputCapabilities.text, 'native')
  assert.equal(adapter.inputCapabilities.largeText, 'transform')
  assert.equal(adapter.inputCapabilities.image, 'native')
  assert.equal(adapter.inputCapabilities.file, 'unsupported')

  await adapter.send('runtime-1', {
    parts: [
      { type: 'text', text: '分析下面日志' },
      { type: 'large-text', text: 'line 1\nline 2', lineCount: 2, charCount: 13 },
    ],
  })

  assert.deepEqual(prompts, ['分析下面日志\n\nline 1\nline 2'])
  await assert.rejects(
    () => adapter.send('runtime-1', {
      parts: [{ type: 'file', attachmentId: 'attachment-1', mimeType: 'text/plain' }],
    }),
    /does not support Live input part: file/,
  )
})

test('Pi Live Adapter resolves image attachments into official Pi image payloads and releases them after acceptance', async () => {
  const sent: Array<{ message: string; images?: readonly PiLiveImageInput[] }> = []
  const removed: string[] = []
  const service = {
    prompt: async (_runtimeSessionId: string, message: string, _behavior: unknown, images?: readonly PiLiveImageInput[]) => {
      sent.push({ message, ...(images ? { images } : {}) })
    },
    steer: async () => {},
    followUp: async () => {},
  } as unknown as PiLiveService
  const attachments = attachmentService({
    get: async attachmentId => attachmentId === 'image-1'
      ? {
          attachmentId,
          sizeBytes: 3,
          mimeType: 'image/png',
          data: new Uint8Array([1, 2, 3]),
        }
      : null,
    remove: async attachmentId => { removed.push(attachmentId) },
  })
  const adapter = new PiLiveAdapter(service, attachments)

  await adapter.send('runtime-1', {
    parts: [
      { type: 'text', text: '看图' },
      { type: 'image', attachmentId: 'image-1', mimeType: 'image/png', sizeBytes: 3 },
    ],
  })

  assert.deepEqual(sent, [{
    message: '看图',
    images: [{
      type: 'image',
      data: Buffer.from([1, 2, 3]).toString('base64'),
      mimeType: 'image/png',
    }],
  }])
  assert.deepEqual(removed, ['image-1'])
})

test('Pi Live Adapter keeps image attachments when native Pi send fails', async () => {
  const removed: string[] = []
  const service = {
    prompt: async () => { throw new Error('Pi rejected prompt') },
    steer: async () => {},
    followUp: async () => {},
  } as unknown as PiLiveService
  const adapter = new PiLiveAdapter(service, attachmentService({
    get: async attachmentId => ({
      attachmentId,
      sizeBytes: 1,
      mimeType: 'image/png',
      data: new Uint8Array([1]),
    }),
    remove: async attachmentId => { removed.push(attachmentId) },
  }))

  await assert.rejects(
    () => adapter.send('runtime-1', {
      parts: [{ type: 'image', attachmentId: 'image-1', mimeType: 'image/png' }],
    }),
    /Pi rejected prompt/,
  )
  assert.deepEqual(removed, [])
})


test('Pi Live Adapter maps native streaming events into the shared Live event vocabulary', () => {
  assert.deepEqual(normalizePiLiveEvent({ type: 'agent_start' }), {
    type: 'status',
    status: 'running',
  })
  assert.deepEqual(normalizePiLiveEvent({
    type: 'message_update',
    messageId: 'assistant-1',
    assistantMessageEvent: { type: 'text_delta', delta: 'hello', contentIndex: 0 },
  }), {
    type: 'text.delta',
    delta: 'hello',
    contentIndex: 0,
    messageId: 'assistant-1',
  })
  assert.deepEqual(normalizePiLiveEvent({
    type: 'message_update',
    messageId: 'assistant-1',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'reason', contentIndex: 1 },
  }), {
    type: 'reasoning.delta',
    delta: 'reason',
    contentIndex: 1,
    messageId: 'assistant-1',
  })
  assert.deepEqual(normalizePiLiveEvent({
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: 'read',
    args: { path: 'README.md' },
  }), {
    type: 'tool.start',
    callId: 'call-1',
    name: 'read',
    inputPreview: '{"path":"README.md"}',
  })
  assert.deepEqual(normalizePiLiveEvent({
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'read',
    result: 'done',
    isError: false,
  }), {
    type: 'tool.end',
    callId: 'call-1',
    name: 'read',
    status: 'success',
    output: 'done',
  })
  assert.deepEqual(normalizePiLiveEvent({
    type: 'queue_update',
    steering: ['先检查测试'],
    followUp: ['完成后总结'],
  }), {
    type: 'queue.update',
    steering: ['先检查测试'],
    followUp: ['完成后总结'],
  })
  assert.deepEqual(normalizePiLiveEvent({ type: 'agent_settled' }), {
    type: 'completed',
    status: 'completed',
  })
})

test('Pi Live Adapter exposes queue control and restores queued messages on interrupt', async () => {
  const calls: string[] = []
  const service = {
    queueState: async () => ({
      steering: ['current steer'],
      followUp: ['current follow-up'],
    }),
    clearQueue: async () => {
      calls.push('clear')
      return { steering: ['queued steer'], followUp: ['queued follow-up'] }
    },
    abort: async () => {
      calls.push('abort')
      return { steering: ['restored steer'], followUp: ['restored follow-up'] }
    },
  } as unknown as PiLiveService

  const adapter = new PiLiveAdapter(service, attachmentService())
  assert.deepEqual(await adapter.queueState('runtime-1'), {
    steering: ['current steer'],
    followUp: ['current follow-up'],
  })
  assert.deepEqual(await adapter.clearQueue('runtime-1'), {
    steering: ['queued steer'],
    followUp: ['queued follow-up'],
  })
  assert.deepEqual(await adapter.interrupt('runtime-1'), {
    restoredQueue: {
      steering: ['restored steer'],
      followUp: ['restored follow-up'],
    },
  })
  assert.deepEqual(calls, ['clear', 'abort'])
})


test('Pi Live Adapter exposes runtime-bound workspace file references generically', async () => {
  const calls: Array<{ runtimeSessionId: string; query: string; limit?: number }> = []
  const service = {
    workspaceFileReferences: async (runtimeSessionId: string, query: string, limit?: number) => {
      calls.push({ runtimeSessionId, query, limit })
      return [{ path: 'src/index.ts', value: '@src/index.ts' }]
    },
  } as unknown as PiLiveService

  const adapter = new PiLiveAdapter(service, attachmentService())
  assert.equal(adapter.capabilities.has('workspace-file-reference'), true)
  assert.deepEqual(await adapter.workspaceFileReferences('runtime-1', 'src', 12), [
    { path: 'src/index.ts', value: '@src/index.ts' },
  ])
  assert.deepEqual(calls, [{ runtimeSessionId: 'runtime-1', query: 'src', limit: 12 }])
})

test('Pi Live Adapter exposes runtime diagnostics only through controlled contribution methods', async () => {
  const calls: string[] = []
  const service = {
    runtimeDisclosures: async () => [{
      contributionId: 'pi.runtime.diagnostics',
      title: { default: 'Runtime diagnostics' },
      fields: [{ label: { default: 'SDK' }, value: '0.84.4' }],
      actions: [{ actionId: 'pi.runtime.retry', label: { default: 'Retry' } }],
    }],
    executeRuntimeAction: async (_runtimeSessionId: string, actionId: string) => {
      calls.push(actionId)
      return {
        runtime: {
          runtimeSessionId: 'runtime-1',
          status: 'initializing' as const,
          isStreaming: false,
          pendingMessageCount: 0,
        },
      }
    },
  } as unknown as PiLiveService

  const adapter = new PiLiveAdapter(service, attachmentService())
  assert.deepEqual(await adapter.runtimeDisclosures('runtime-1'), [{
    contributionId: 'pi.runtime.diagnostics',
    title: { default: 'Runtime diagnostics' },
    fields: [{ label: { default: 'SDK' }, value: '0.84.4' }],
    actions: [{ actionId: 'pi.runtime.retry', label: { default: 'Retry' } }],
  }])
  assert.deepEqual(await adapter.executeRuntimeAction('runtime-1', 'pi.runtime.retry'), {
    runtime: {
      runtimeSessionId: 'runtime-1',
      status: 'initializing',
      isStreaming: false,
      pendingMessageCount: 0,
    },
  })
  assert.deepEqual(calls, ['pi.runtime.retry'])
})

test('Pi Live Adapter exposes private message semantics only through controlled contribution methods', async () => {
  const calls: Array<{ actionId: string; targetEntryId: string }> = []
  const service = {
    messageActions: async () => [{
      actionId: 'pi.private-action',
      label: { default: 'Private action', localizations: { 'zh-CN': '私有动作', 'en-US': 'Private action' } },
      roles: ['user'] as const,
      requiresIdle: true,
    }],
    executeMessageAction: async (_runtimeSessionId: string, actionId: string, targetEntryId: string) => {
      calls.push({ actionId, targetEntryId })
      return { outcome: 'refresh-current' as const, draftText: 'draft' }
    },
  } as unknown as PiLiveService

  const adapter = new PiLiveAdapter(service, attachmentService())
  assert.deepEqual(await adapter.messageActions('runtime-1'), [{
    actionId: 'pi.private-action',
    label: { default: 'Private action', localizations: { 'zh-CN': '私有动作', 'en-US': 'Private action' } },
    roles: ['user'],
    requiresIdle: true,
  }])
  assert.deepEqual(
    await adapter.executeMessageAction('runtime-1', 'pi.private-action', 'entry-1'),
    { outcome: 'refresh-current', draftText: 'draft' },
  )
  assert.deepEqual(calls, [{ actionId: 'pi.private-action', targetEntryId: 'entry-1' }])
})

test('Pi Live Adapter exposes Runtime commands through generic command-discovery', async () => {
  const service = {
    commands: async () => [
      { name: 'review', description: 'Review changes', source: 'extension' as const },
      { name: 'explain', description: 'Explain code', source: 'prompt' as const },
      { name: 'skill:repo-review', description: 'Review repository', source: 'skill' as const },
    ],
  } as unknown as PiLiveService

  const adapter = new PiLiveAdapter(service, attachmentService())
  assert.equal(adapter.capabilities.has('command-discovery'), true)
  assert.deepEqual(await adapter.commands('runtime-1'), [
    { value: '/review', label: '/review', description: 'Review changes', group: 'extension' },
    { value: '/explain', label: '/explain', description: 'Explain code', group: 'prompt' },
    { value: '/skill:repo-review', label: '/skill:repo-review', description: 'Review repository', group: 'skill' },
  ])
})
