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
    type: 'reasoning.delta',
    delta: 'thinking',
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
