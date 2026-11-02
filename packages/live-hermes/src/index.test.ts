import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesLiveAdapter, hermesLiveManifest, normalizeHermesLiveEvent } from './index'
import { DefaultHermesLiveService } from './service'
import type { HermesApiClient } from './client'

test('Hermes Live does not advertise Pi thinking-control semantics', () => {
  assert.equal(hermesLiveManifest.capabilities?.includes('thinking-control') ?? false, false)
})

test('Hermes Live shares the unified text message contract without claiming attachment support', async () => {
  const prompts: string[] = []
  const service = {
    prompt: async (_runtimeSessionId: string, value: string) => { prompts.push(value) },
  } as unknown as DefaultHermesLiveService

  const adapter = new HermesLiveAdapter(service)
  assert.equal(adapter.inputCapabilities.text, 'native')
  assert.equal(adapter.inputCapabilities.largeText, 'transform')
  assert.equal(adapter.inputCapabilities.image, 'unsupported')
  assert.equal(adapter.inputCapabilities.file, 'unsupported')

  await adapter.send('runtime-1', {
    parts: [
      { type: 'text', text: 'summarize' },
      { type: 'large-text', text: 'a\nb', lineCount: 2, charCount: 3 },
    ],
  })
  assert.deepEqual(prompts, ['summarize\n\na\nb'])
})


test('Hermes Live preserves the generic task title in Runtime state', async () => {
  const client = {
    createSession: async (input: { title?: string }) => {
      assert.equal(input.title, 'Hermes task')
      return 'session-1'
    },
  } as unknown as HermesApiClient
  const service = new DefaultHermesLiveService(client)

  const state = await service.start({ title: 'Hermes task' })
  assert.equal(state.title, 'Hermes task')
  assert.equal((await service.state(state.runtimeSessionId)).title, 'Hermes task')

  await service.dispose()
})

test('Hermes Live maps task title updates into the generic Live event', () => {
  assert.deepEqual(normalizeHermesLiveEvent({
    event: 'task.title.updated',
    title: 'Hermes task',
  }), {
    type: 'title.update',
    title: 'Hermes task',
  })
})

test('Hermes Live maps public run events into the same Live renderer vocabulary', () => {
  assert.deepEqual(normalizeHermesLiveEvent({
    event: 'assistant.delta',
    message_id: 'message-1',
    delta: 'hello',
  }), {
    type: 'text.delta',
    messageId: 'message-1',
    delta: 'hello',
  })
  assert.deepEqual(normalizeHermesLiveEvent({
    event: 'reasoning.available',
    text: 'thinking',
  }), {
    type: 'reasoning.end',
    text: 'thinking',
  })
  assert.deepEqual(normalizeHermesLiveEvent({
    event: 'tool.started',
    tool: 'terminal',
    preview: 'ls',
  }), {
    type: 'tool.start',
    name: 'terminal',
    inputPreview: 'ls',
  })
  assert.deepEqual(normalizeHermesLiveEvent({
    event: 'tool.completed',
    tool: 'terminal',
    duration: 0.25,
    error: false,
    preview: 'ok',
  }), {
    type: 'tool.end',
    name: 'terminal',
    status: 'success',
    output: 'ok',
    durationMs: 250,
  })
  assert.deepEqual(normalizeHermesLiveEvent({ event: 'run.completed' }), {
    type: 'completed',
    status: 'completed',
  })
})


test('Hermes exposes object-shaped transport and terminal diagnostics without guessing status codes', () => {
  assert.deepEqual(normalizeHermesLiveEvent({
    event: 'transport.error',
    error: { code: 'CONNECTION_LOST', message: 'socket closed', category: 'network', retryable: false },
  }), {
    type: 'error', message: 'socket closed', code: 'CONNECTION_LOST',
    category: 'network', retryable: false,
  })
  assert.deepEqual(normalizeHermesLiveEvent({
    event: 'run.failed', error: { code: 'NATIVE_FAILURE', cause: { message: 'failed to start' } },
  }), {
    type: 'completed', status: 'failed', message: 'failed to start',
    code: 'NATIVE_FAILURE',
  })
})


test('Hermes Live passes native bounded snapshot windows through the existing Live contract', async () => {
  const calls: Array<Record<string, unknown> | undefined> = []
  const client = {
    createSession: async () => 'session-1',
    sessionMessagesPage: async (_native: string, window: Record<string, unknown> | undefined) => {
      calls.push(window)
      return {
        entries: [{ id: '53', role: 'user', content: 'older turn' }],
        page: { hasEarlier: true, before: 'hermes-history:latest:240', hasLater: true,
          after: 'hermes-history:latest:119' },
      }
    },
  } as unknown as HermesApiClient
  const service = new DefaultHermesLiveService(client)
  try {
    const state = await service.start({})
    const page = await service.snapshot(state.runtimeSessionId, undefined,
      { before: 'hermes-history:latest:120', limit: 120 })
    assert.deepEqual(calls, [{ before: 'hermes-history:latest:120', limit: 120 }])
    assert.equal(page.entries.length, 1)
    assert.equal(page.page?.before, 'hermes-history:latest:240')
    assert.equal(page.page?.hasLater, true)
  } finally {
    await service.dispose()
  }
})
