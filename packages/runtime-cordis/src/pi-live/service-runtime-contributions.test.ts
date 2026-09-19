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
      warmWorkerStatus: 'hit',
      extensionBindingStatus: 'ready',
      startupMetrics: [
        { name: 'sdk_import_ms', durationMs: 0 },
        { name: 'model_runtime_create_ms', durationMs: 0 },
        { name: 'cwd_services_create_ms', durationMs: 42 },
      ],
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
    assert.equal(disclosure.title.default, 'This run')
    assert.equal(disclosure.title.localizations?.['zh-CN'], '本次运行')
    assert.equal(disclosure.summary?.default, 'Ready · Contexts 1 · Skills 1 · Prompts 1 · Extensions 1')
    assert.equal(disclosure.summary?.localizations?.['zh-CN'], '就绪 · 上下文 1 · 技能 1 · 提示词 1 · 扩展 1')

    const labels = disclosure.fields.map(field => field.label.default)
    assert.equal(labels.includes('Pi SDK'), true)
    assert.equal(labels.includes('Runtime mode'), true)
    assert.equal(labels.includes('Worker PID'), true)
    assert.equal(labels.includes('Warm worker'), true)
    assert.equal(labels.includes('Extensions'), true)
    assert.equal(labels.includes('Startup metrics'), true)
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


test('Pi Runtime Disclosure stays visible while extension binding is pending or failed', async () => {
  class BindingHost implements PiRuntimeHost {
    constructor(private readonly binding: 'binding' | 'failed') {}
    async start(
      runtimeSessionId: string,
      _input: PiLiveStartInput,
      _signal: AbortSignal,
      _onEvent: (event: Record<string, unknown>) => void,
      _onExit: (error: Error) => void,
    ): Promise<PiRuntimeHandle> {
      const state = (): PiLiveRuntimeState => ({
        runtimeSessionId,
        status: 'ready',
        extensionBindingStatus: this.binding,
        ...(this.binding === 'failed' ? { extensionBindingError: 'extension failed' } : {}),
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
      })
      return {
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

  for (const binding of ['binding', 'failed'] as const) {
    const service = new DefaultPiLiveService(new BindingHost(binding))
    try {
      const started = await service.start({ cwd: '/workspace' })
      await waitForStatus(service, started.runtimeSessionId, 'ready')
      const disclosure = (await service.runtimeDisclosures(started.runtimeSessionId))[0]
      assert.ok(disclosure)
      assert.equal(disclosure.defaultExpanded, true)
      assert.equal(disclosure.tone, binding === 'failed' ? 'danger' : 'info')
    } finally {
      await service.dispose()
    }
  }
})


test('Runtime resource summary hides zero categories and updates in place after resource discovery', async () => {
  let emit: ((event: Record<string, unknown>) => void) | undefined

  class ResourceSummaryHost implements PiRuntimeHost {
    async start(
      runtimeSessionId: string,
      _input: PiLiveStartInput,
      _signal: AbortSignal,
      onEvent: (event: Record<string, unknown>) => void,
      _onExit: (error: Error) => void,
    ): Promise<PiRuntimeHandle> {
      emit = onEvent
      const state = (): PiLiveRuntimeState => ({
        runtimeSessionId,
        status: 'ready',
        extensionBindingStatus: 'binding',
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
      })
      return {
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

  const service = new DefaultPiLiveService(new ResourceSummaryHost())
  try {
    const started = await service.start({ cwd: '/workspace' })
    await waitForStatus(service, started.runtimeSessionId, 'ready')

    const before = (await service.runtimeDisclosures(started.runtimeSessionId))[0]
    assert.ok(before?.summary)
    assert.equal(before.summary.default.includes('Contexts 0'), false)
    assert.equal(before.summary.default.includes('Skills 0'), false)
    assert.equal(before.summary.default.includes('Extensions 0'), false)

    emit?.({
      type: 'runtime_resources',
      resources: {
        contexts: ['AGENTS.md', 'PROJECT.md'],
        skills: ['review'],
        prompts: [],
        extensions: ['ext-a', 'ext-b'],
        themes: ['dark'],
        diagnostics: [],
      },
    })
    emit?.({ type: 'runtime_extension_binding', status: 'ready' })

    const after = (await service.runtimeDisclosures(started.runtimeSessionId))[0]
    assert.equal(after?.summary?.default, 'Ready · Contexts 2 · Skills 1 · Extensions 2')
    assert.equal(after?.summary?.localizations?.['zh-CN'], '就绪 · 上下文 2 · 技能 1 · 扩展 2')
    assert.equal(after?.summary?.default.includes('Themes'), false)
  } finally {
    await service.dispose()
  }
})
