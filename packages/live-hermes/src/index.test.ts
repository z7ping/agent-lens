import assert from 'node:assert/strict'
import test from 'node:test'
import { HermesLiveAdapter, hermesLiveManifest } from './index'
import type { DefaultHermesLiveService } from './service'

test('Hermes Live does not advertise Pi thinking-control semantics', () => {
  assert.equal(hermesLiveManifest.capabilities.includes('thinking-control'), false)
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
