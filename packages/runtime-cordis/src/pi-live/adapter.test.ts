import { Buffer } from 'node:buffer'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveAttachmentService, StorageService } from '@agent-lens/core'
import { normalizePiLiveEvent, normalizePiLiveRuntimeEvent, PiLiveAdapter } from './adapter'
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

test('Pi Live Adapter distinguishes terminal Runtime exit from recoverable extension error', () => {
  assert.deepEqual(normalizePiLiveEvent({
    type: 'runtime_exit',
    errorMessage: 'worker exited',
  }), {
    type: 'status',
    status: 'failed',
    message: 'worker exited',
  })
  assert.deepEqual(normalizePiLiveEvent({
    type: 'extension_error',
    error: 'extension failed',
  }), {
    type: 'error',
    message: 'extension failed',
  })
})

test('Pi Live propagates persisted assistant errors immediately without replacing other message events', () => {
  const failed = normalizePiLiveEvent({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'error',
      content: [],
      errorMessage: "HTTP 422: developer role is not supported",
    },
  })
  assert.equal(failed?.type, 'error')
  assert.match(failed?.type === 'error' ? failed.message : '', /HTTP 422: developer role is not supported/)
  assert.match(failed?.type === 'error' ? failed.message : '', /compat\.supportsDeveloperRole=false/)
  assert.match(failed?.type === 'error' ? failed.message : '', /models\.json/)
  assert.deepEqual(normalizePiLiveEvent({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', content: [], errorMessage: 'HTTP 500: generic provider failure' },
  }), { type: 'error', message: 'HTTP 500: generic provider failure' })
  assert.deepEqual(normalizePiLiveEvent({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', errorMessage: 'HTTP 422: unsupported image format' },
  }), { type: 'error', message: 'HTTP 422: unsupported image format' })
  assert.deepEqual(normalizePiLiveEvent({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] },
  }), { type: 'message.end', role: 'assistant', phase: 'final' })
  assert.deepEqual(normalizePiLiveEvent({
    type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  }), { type: 'message.end', role: 'user' })
})

test('Pi Live Adapter maps native control and compaction changes into generic events', () => {
  assert.deepEqual(normalizePiLiveEvent({ type: 'model_changed' }), {
    type: 'control.changed',
    control: 'model',
  })
  assert.deepEqual(normalizePiLiveEvent({ type: 'thinking_level_changed' }), {
    type: 'control.changed',
    control: 'thinking',
  })
  assert.deepEqual(normalizePiLiveEvent({ type: 'compaction_start' }), {
    type: 'status',
    status: 'compacting',
  })
  assert.deepEqual(normalizePiLiveEvent({ type: 'compaction_end' }), {
    type: 'status',
    status: 'ready',
  })
})

test('Pi Live Adapter invalidates Runtime Disclosure for private diagnostic updates', () => {
  for (const event of [
    { type: 'runtime_resources', resources: {} },
    { type: 'package_updates', status: 'complete', updates: [] },
    { type: 'runtime_extension_binding', status: 'ready' },
  ]) {
    assert.deepEqual(normalizePiLiveEvent(event), { type: 'runtime-disclosure.changed' })
  }

  // Fine-grained startup telemetry stays on the SSE stream but must not trigger
  // one extra HTTP disclosure read per metric/log line.
  assert.equal(normalizePiLiveEvent({ type: 'runtime_startup_metric', metric: { name: 'sdk_import_ms', durationMs: 1 } }), undefined)
  assert.equal(normalizePiLiveEvent({ type: 'runtime_output', message: 'loading resource' }), undefined)
})

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
  assert.equal(normalizePiLiveEvent({ type: 'agent_end' }), undefined)
  assert.deepEqual(normalizePiLiveEvent({ type: 'agent_settled' }), {
    type: 'completed',
    status: 'completed',
  })
  assert.deepEqual(
    normalizePiLiveRuntimeEvent({
      runtimeSessionId: 'runtime-1',
      sequence: 1,
      receivedAt: '2026-09-23T00:00:00.000Z',
      event: { type: 'agent_end' },
    }),
    {
      runtimeSessionId: 'runtime-1',
      sequence: 1,
      receivedAt: '2026-09-23T00:00:00.000Z',
      event: { type: 'agent_end' },
    },
  )
})

test('Pi 1.2 Live maps settled aborts without treating intermediate agent_end as terminal', () => {
  assert.equal(normalizePiLiveEvent({ type: 'agent_end', willRetry: false }), undefined)
  assert.deepEqual(normalizePiLiveEvent({ type: 'agent_settled', aborted: true }), {
    type: 'completed',
    status: 'cancelled',
  })
  assert.deepEqual(normalizePiLiveEvent({ type: 'agent_settled', aborted: false }), {
    type: 'completed',
    status: 'completed',
  })
})

test('Pi 1.2 Live carries native monotonic tool duration when present', () => {
  const base = {
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'bash',
    result: 'done',
    isError: false,
  }
  const result = {
    type: 'tool.end',
    callId: 'call-1',
    name: 'bash',
    status: 'success',
    output: 'done',
  }
  assert.deepEqual(normalizePiLiveEvent({ ...base, durationMs: 127.5 }), {
    ...result,
    durationMs: 127.5,
  })
  assert.deepEqual(normalizePiLiveEvent({ ...base, durationMs: 0 }), {
    ...result,
    durationMs: 0,
  })
  // Absent/invalid durations are not guessed from the client clock.
  for (const durationMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(normalizePiLiveEvent({ ...base, durationMs }), result)
  }
})

test('Pi 1.2 MCP 注册来源与 Codemode 嵌套调用保留为通用 Live 事实', () => {
  const start = normalizePiLiveEvent({
    type: 'tool_execution_start', toolCallId: 'parent-1/0', parentToolCallId: 'parent-1',
    toolName: 'mcp__dbx__execute_query', args: { sql: 'select 1' },
    toolSourceType: 'mcp', mcpServerId: 'dbx',
    toolRegistration: { registry: 'pi.AgentSession.getAllTools', source: 'builtin:mcp', namespace: 'mcp__dbx' },
  })
  assert.deepEqual(start, {
    type: 'tool.start', callId: 'parent-1/0', parentToolCallId: 'parent-1',
    name: 'mcp__dbx__execute_query', toolSourceType: 'mcp', mcpServerId: 'dbx',
    inputPreview: '{"sql":"select 1"}',
  })
  assert.deepEqual(normalizePiLiveEvent({
    type: 'tool_execution_end', toolCallId: 'parent-1/0', parentToolCallId: 'parent-1',
    toolName: 'mcp__dbx__execute_query', result: { content: [{ type: 'text', text: 'ok' }] },
    isError: false,
  }), {
    type: 'tool.end', callId: 'parent-1/0', parentToolCallId: 'parent-1',
    name: 'mcp__dbx__execute_query', status: 'success',
    output: '{"content":[{"type":"text","text":"ok"}]}',
  })
  const unknown = normalizePiLiveEvent({
    type: 'tool_execution_start', toolCallId: 'tool-2',
    toolName: 'mcp__dbx__execute_query', args: {},
  })
  assert.ok(unknown?.type === 'tool.start')
  assert.equal(unknown.toolSourceType, undefined, '名称无法单独证明 MCP 归属')
  assert.equal(unknown.mcpServerId, undefined)
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
      calls.push({ runtimeSessionId, query, ...(limit !== undefined ? { limit } : {}) })
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


test('Pi Live Adapter exposes full-session history index through bounded queries', async () => {
  const calls: Array<{ runtimeSessionId: string; query?: { fromOrdinal?: number; limit?: number } }> = []
  const service = {
    historyIndex: async (runtimeSessionId: string, query?: { fromOrdinal?: number; limit?: number }) => {
      calls.push({ runtimeSessionId, ...(query !== undefined ? { query } : {}) })
      return { total: 2, items: query?.limit ? [
        { cursor: 'user-2', ordinal: 2, preview: 'two' },
      ] : [] }
    },
  } as unknown as PiLiveService

  const adapter = new PiLiveAdapter(service, attachmentService())
  assert.equal(adapter.capabilities.has('history-index'), true)
  assert.deepEqual(await adapter.historyIndex('runtime-1', { fromOrdinal: 2, limit: 1 }), {
    total: 2,
    items: [{ cursor: 'user-2', ordinal: 2, preview: 'two' }],
  })
  assert.deepEqual(calls, [{
    runtimeSessionId: 'runtime-1',
    query: { fromOrdinal: 2, limit: 1 },
  }])
})


test('Pi Live Adapter exposes native session tree only through the generic session-tree capability', async () => {
  const tree = {
    activeLeafId: 'entry-2',
    nodes: [
      { id: 'entry-1', parentId: null, type: 'message' as const, role: 'user' as const, preview: 'hello', activePath: true, childCount: 1 },
      { id: 'entry-2', parentId: 'entry-1', type: 'branch-summary' as const, summary: 'summary', activePath: true, childCount: 0 },
    ],
    branchPointIds: [],
    capabilities: {
      switchBranch: true,
      fork: true,
      clone: false,
      branchSummary: true,
    },
  }
  const calls: string[] = []
  const service = {
    sessionTree: async (runtimeSessionId: string) => {
      calls.push(runtimeSessionId)
      return tree
    },
  } as unknown as PiLiveService

  const adapter = new PiLiveAdapter(service, attachmentService())
  assert.equal(adapter.capabilities.has('session-tree'), true)
  assert.deepEqual(await adapter.sessionTree('runtime-1'), tree)
  assert.deepEqual(calls, ['runtime-1'])
  assert.equal(Object.hasOwn(tree.nodes[0]!, 'entry'), false)
})

test('Pi history round fork validates the native assistant anchor in the original session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentlens-pi-fork-at-'))
  const file = join(root, 'session.jsonl')
  const header = { type: 'session', id: 'native-session', cwd: root }
  const assistant = { type: 'message', id: 'assistant-1', message: { role: 'assistant' } }
  const user = { type: 'message', id: 'user-1', message: { role: 'user' } }
  try {
    await writeFile(file, [header, assistant, user].map(value => JSON.stringify(value)).join('\n') + '\n')
    const sourceRecord = (entry: typeof header | typeof assistant | typeof user) => ({
      sourceId: 'pi',
      installationId: 'installation-1',
      sourceSessionNativeId: 'native-session',
      nativeType: `history/${entry.type}`,
      locator: { kind: 'file', path: file },
      payload: { entry, session: { cwd: root } },
    })
    const records = new Map([
      [header.id, sourceRecord(header)],
      [assistant.id, sourceRecord(assistant)],
      [user.id, sourceRecord(user)],
    ])
    const storage = {
      repositories: {
        sessions: {
          getLogicalSession: async () => ({ workspaceId: 'workspace-1' }),
          getWorkspace: async () => ({ path: root }),
          listSourceSessionsByLogicalSession: async () => [
            { installationId: 'installation-1', nativeSessionId: 'native-session' },
          ],
        },
        sourceRecords: {
          findByNativeId: async (_sourceId: string, _installationId: string, nativeId: string) => records.get(nativeId) ?? null,
        },
      },
    } as unknown as StorageService
    const started: unknown[] = []
    const service = {
      start: async (input: unknown) => {
        started.push(input)
        return readyState
      },
    } as unknown as PiLiveService
    const adapter = new PiLiveAdapter(service, attachmentService(), storage)

    await adapter.forkAt('logical-1', assistant.id)
    assert.equal(started.length, 1)
    assert.deepEqual(started[0], {
      cwd: root,
      sessionPath: file,
      historyAction: 'fork',
      logicalSessionId: 'logical-1',
      branchFromEntryId: assistant.id,
    })
    await assert.rejects(() => adapter.forkAt('logical-1', user.id), /uniquely verified Pi assistant/)
    await assert.rejects(() => adapter.forkAt('logical-1', 'unknown-entry'), /uniquely verified Pi assistant/)
    assert.equal(started.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
