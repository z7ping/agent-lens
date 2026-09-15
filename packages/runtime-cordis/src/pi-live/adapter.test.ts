import assert from 'node:assert/strict'
import test from 'node:test'
import { PiLiveAdapter } from './adapter'
import type { PiLiveRuntimeState, PiLiveService } from './types'

const readyState: PiLiveRuntimeState = {
  runtimeSessionId: 'runtime-1',
  status: 'ready',
  thinkingLevel: 'xhigh',
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
}

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

  const adapter = new PiLiveAdapter(service)
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

  const adapter = new PiLiveAdapter(service)
  assert.equal(await adapter.thinkingControl('runtime-1'), null)
})

test('Pi Live Adapter accepts unified text and large-text messages without leaking Pi-specific markers', async () => {
  const prompts: string[] = []
  const service = {
    prompt: async (_runtimeSessionId: string, value: string) => { prompts.push(value) },
    steer: async () => {},
    followUp: async () => {},
  } as unknown as PiLiveService

  const adapter = new PiLiveAdapter(service)
  assert.equal(adapter.inputCapabilities.text, 'native')
  assert.equal(adapter.inputCapabilities.largeText, 'transform')
  assert.equal(adapter.inputCapabilities.image, 'unsupported')

  await adapter.send('runtime-1', {
    parts: [
      { type: 'text', text: '分析下面日志' },
      { type: 'large-text', text: 'line 1\nline 2', lineCount: 2, charCount: 13 },
    ],
  })

  assert.deepEqual(prompts, ['分析下面日志\n\nline 1\nline 2'])
  await assert.rejects(
    () => adapter.send('runtime-1', {
      parts: [{ type: 'image', attachmentId: 'attachment-1', mimeType: 'image/png' }],
    }),
    /does not support Live input part: image/,
  )
})
