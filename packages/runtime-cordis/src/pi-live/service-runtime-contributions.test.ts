import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultPiLiveService } from './service'
import type { PiRuntimeHandle, PiRuntimeHost } from './worker-host'
import type { PiLiveRuntimeState, PiLiveStartInput } from './types'

class RuntimeContributionHost implements PiRuntimeHost {
  starts = 0

  async start(
    runtimeSessionId: string,
    _input: PiLiveStartInput,
    _signal: AbortSignal,
    _onEvent: (event: Record<string, unknown>) => void,
    _onExit: (error: Error) => void,
  ): Promise<PiRuntimeHandle> {
    this.starts += 1
    if (this.starts === 1) throw new Error('SDK bootstrap failed')

    const state = (): PiLiveRuntimeState => ({
      runtimeSessionId,
      status: 'ready',
      sdkVersion: '0.84.4',
      runtimeMode: 'compatibility',
      startupResources: {
        contexts: ['AGENTS.md'],
        skills: ['repo-review'],
        prompts: ['explain'],
        extensions: ['extension-a'],
        themes: [],
        diagnostics: ['theme directory unavailable'],
      },
      packageUpdates: [{
        displayName: '@scope/pkg',
        type: 'npm',
        scope: 'project',
      }],
      packageUpdateCheck: 'complete',
      startupOutput: ['Pi worker started'],
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      leafId: null,
    })
    return {
      processId: 4321,
      state: async () => state(),
      snapshot: async () => ({ state: state(), entries: [], leafId: null }),
      controls: async () => ({ models: [] }),
      setModel: async () => state(),
      setThinkingLevel: async () => state(),
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      clearQueue: async () => ({ steering: [], followUp: [] }),
      abort: async () => ({ steering: [], followUp: [] }),
      respondToExtension: async () => {},
      terminate: async () => {},
    }
  }
}

async function waitForStatus(
  service: DefaultPiLiveService,
  runtimeSessionId: string,
  status: PiLiveRuntimeState['status'],
) {
  for (let index = 0; index < 100; index += 1) {
    const state = await service.state(runtimeSessionId)
    if (state.status === status) return state
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`runtime did not reach ${status}`)
}

test('Pi failed Runtime exposes retry only through a runtime disclosure contribution', async () => {
  const host = new RuntimeContributionHost()
  const service = new DefaultPiLiveService(host)
  try {
    const started = await service.start({ cwd: '/workspace' })
    const failed = await waitForStatus(service, started.runtimeSessionId, 'failed')
    assert.match(failed.error ?? '', /SDK bootstrap failed/)

    const disclosures = await service.runtimeDisclosures(started.runtimeSessionId)
    assert.equal(disclosures.length, 1)
    assert.equal(disclosures[0]?.contributionId, 'pi.runtime.diagnostics')
    assert.equal(disclosures[0]?.tone, 'danger')
    assert.equal(disclosures[0]?.defaultExpanded, true)
    assert.deepEqual(disclosures[0]?.actions?.map(action => action.actionId), ['pi.runtime.retry'])
    assert.equal(
      disclosures[0]?.fields.some(field =>
        field.label.default === 'Runtime error'
        && typeof field.value === 'string'
        && field.value.includes('SDK bootstrap failed')),
      true,
    )
  } finally {
    await service.dispose()
  }
})

test('Pi runtime retry action reuses native retry lifecycle and becomes a ready diagnostic disclosure', async () => {
  const host = new RuntimeContributionHost()
  const service = new DefaultPiLiveService(host)
  try {
    const started = await service.start({ cwd: '/workspace' })
    await waitForStatus(service, started.runtimeSessionId, 'failed')

    const result = await service.executeRuntimeAction(started.runtimeSessionId, 'pi.runtime.retry')
    assert.equal(result.runtime.status, 'initializing')

    const ready = await waitForStatus(service, started.runtimeSessionId, 'ready')
    assert.equal(host.starts, 2)
    assert.equal(ready.processId, 4321)

    const disclosures = await service.runtimeDisclosures(started.runtimeSessionId)
    const disclosure = disclosures[0]
    assert.ok(disclosure)
    assert.equal(disclosure.tone, 'neutral')
    assert.equal(disclosure.defaultExpanded, false)
    assert.equal(disclosure.actions, undefined)

    const labels = disclosure.fields.map(field => field.label.default)
    assert.equal(labels.includes('Pi SDK'), true)
    assert.equal(labels.includes('Runtime mode'), true)
    assert.equal(labels.includes('Worker PID'), true)
    assert.equal(labels.includes('Contexts'), true)
    assert.equal(labels.includes('Skills'), true)
    assert.equal(labels.includes('Package updates'), true)
    assert.equal(labels.includes('Resource diagnostics'), true)
  } finally {
    await service.dispose()
  }
})

test('Pi runtime contribution rejects undeclared actions at the service boundary too', async () => {
  const host = new RuntimeContributionHost()
  const service = new DefaultPiLiveService(host)
  try {
    const started = await service.start({ cwd: '/workspace' })
    await waitForStatus(service, started.runtimeSessionId, 'failed')
    await assert.rejects(
      () => service.executeRuntimeAction(started.runtimeSessionId, 'pi.runtime.hidden'),
      /Unknown Pi runtime action/,
    )
  } finally {
    await service.dispose()
  }
})
