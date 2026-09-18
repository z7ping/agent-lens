import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  Disposable,
  LiveAdapter,
  LiveAdapterManifest,
  LiveCapabilityName,
  LiveMessageInput,
  LiveModelControl,
  LiveRuntimeEvent,
  LiveRuntimeState,
  LiveSendOptions,
  LiveService,
  LiveSnapshot,
} from '@agent-lens/core'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { startHttpSurface } from './server'

class FakeLiveAdapter implements LiveAdapter {
  readonly manifest: LiveAdapterManifest = {
    pluginId: '@agent-lens/test-live',
    pluginVersion: '1.0.0',
    apiVersion: '1.0',
    pluginType: 'live',
    displayName: 'Test Live',
    liveId: 'test',
    productId: 'test-agent',
    capabilities: ['create', 'resume', 'fork', 'send', 'stream', 'interrupt', 'queue', 'command-discovery', 'workspace-file-reference', 'model-switching', 'extension-ui'],
  }
  readonly capabilities: ReadonlySet<LiveCapabilityName> = new Set(['create', 'resume', 'fork', 'send', 'stream', 'interrupt', 'queue', 'command-discovery', 'workspace-file-reference', 'model-switching', 'extension-ui'])
  readonly inputCapabilities = {
    text: 'native' as const,
    largeText: 'native' as const,
    image: 'unsupported' as const,
    file: 'unsupported' as const,
    multiline: 'native' as const,
  }
  readonly startCapabilities = {
    workspace: 'optional',
    title: 'optional',
  } as const
  readonly sent: Array<{ runtimeSessionId: string; message: LiveMessageInput; options?: LiveSendOptions | undefined }> = []
  readonly runtimes = new Map<string, LiveRuntimeState>()
  readonly extensionResponses: Array<{ runtimeSessionId: string; requestId: string; response: unknown }> = []
  readonly messageActionExecutions: Array<{ runtimeSessionId: string; actionId: string; targetEntryId: string }> = []
  readonly historyInteractions: Array<{ action: 'resume' | 'fork'; logicalSessionId: string }> = []
  readonly queueMessages = { steering: ['queued steer'], followUp: ['queued follow-up'] }
  readonly readCounts = { availability: 0, list: 0, state: 0, snapshot: 0 }
  private modelValue = 'model-a'
  private sequence = 0

  constructor(
    private readonly failList = false,
    private readonly readDelayMs = 0,
  ) {}

  private async delayRead() {
    if (this.readDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.readDelayMs))
  }

  async availability() {
    this.readCounts.availability += 1
    await this.delayRead()
    return { available: true }
  }

  async list() {
    this.readCounts.list += 1
    await this.delayRead()
    if (this.failList) throw new Error('runtime list temporarily unavailable')
    return [...this.runtimes.values()]
  }

  async start(input: unknown) {
    const id = `runtime-${++this.sequence}`
    const workspacePath = input && typeof input === 'object' && typeof (input as Record<string, unknown>).workspacePath === 'string'
      ? (input as Record<string, string>).workspacePath
      : undefined
    const state: LiveRuntimeState = {
      runtimeSessionId: id,
      status: 'ready',
      ...(workspacePath ? { workspacePath } : {}),
      isStreaming: false,
      pendingMessageCount: 0,
    }
    this.runtimes.set(id, state)
    return state
  }

  async resume(logicalSessionId: string) {
    this.historyInteractions.push({ action: 'resume', logicalSessionId })
    return this.start({ workspacePath: `/history/${logicalSessionId}` })
  }

  async fork(logicalSessionId: string) {
    this.historyInteractions.push({ action: 'fork', logicalSessionId })
    return this.start({ workspacePath: `/history/${logicalSessionId}` })
  }

  async state(runtimeSessionId: string) {
    this.readCounts.state += 1
    await this.delayRead()
    const state = this.runtimes.get(runtimeSessionId)
    if (!state) throw new Error(`Unknown Live runtime: ${runtimeSessionId}`)
    return state
  }

  async snapshot(runtimeSessionId: string): Promise<LiveSnapshot> {
    this.readCounts.snapshot += 1
    await this.delayRead()
    return { state: await this.state(runtimeSessionId), entries: [{ kind: 'snapshot' }] }
  }

  async modelControl(runtimeSessionId: string): Promise<LiveModelControl> {
    await this.state(runtimeSessionId)
    return {
      capability: 'model-switching',
      value: this.modelValue,
      options: [
        { value: 'model-a', label: 'Model A' },
        { value: 'model-b', label: 'Model B' },
      ],
    }
  }

  async setModelControl(runtimeSessionId: string, value: string) {
    const control = await this.modelControl(runtimeSessionId)
    if (!control.options.some(option => option.value === value)) throw new Error('Unsupported model')
    this.modelValue = value
    return this.state(runtimeSessionId)
  }

  async respondToExtension(runtimeSessionId: string, requestId: string, response: unknown) {
    await this.state(runtimeSessionId)
    this.extensionResponses.push({ runtimeSessionId, requestId, response })
  }

  async send(runtimeSessionId: string, message: LiveMessageInput, options?: LiveSendOptions) {
    await this.state(runtimeSessionId)
    this.sent.push({ runtimeSessionId, message, ...(options ? { options } : {}) })
  }

  subscribe(runtimeSessionId: string, _listener: (event: LiveRuntimeEvent) => void) {
    void this.state(runtimeSessionId)
    return () => undefined
  }

  async commands(runtimeSessionId: string) {
    await this.state(runtimeSessionId)
    return [
      { value: '/review', label: '/review', description: 'Review changes', group: 'extension' },
      { value: '/skill:repo-review', label: '/skill:repo-review', group: 'skill' },
    ]
  }

  async workspaceFileReferences(runtimeSessionId: string, query: string, limit = 20) {
    await this.state(runtimeSessionId)
    return [
      { path: 'src/index.ts', value: '@src/index.ts' },
      { path: 'docs/user guide.md', value: '@"docs/user guide.md"' },
    ].filter(item => item.path.includes(query)).slice(0, limit)
  }

  async messageActions(runtimeSessionId: string) {
    await this.state(runtimeSessionId)
    return [
      {
        actionId: 'test.rewind',
        label: { default: 'Rewind', localizations: { 'zh-CN': '回到这里', 'en-US': 'Rewind' } },
        roles: ['user'] as const,
        requiresIdle: true,
      },
      {
        actionId: 'test.open',
        label: { default: 'Open', localizations: { 'zh-CN': '打开', 'en-US': 'Open' } },
        roles: ['user'] as const,
        requiresIdle: true,
      },
    ]
  }

  async executeMessageAction(runtimeSessionId: string, actionId: string, targetEntryId: string) {
    await this.state(runtimeSessionId)
    this.messageActionExecutions.push({ runtimeSessionId, actionId, targetEntryId })
    if (actionId === 'test.open') {
      const state = await this.state(runtimeSessionId)
      return {
        outcome: 'open-runtime' as const,
        runtime: { ...state, privateDiagnostic: 'must-not-cross-generic-http' },
        draftText: 'new draft',
      }
    }
    return {
      outcome: 'refresh-current' as const,
      draftText: 'restored draft',
    }
  }

  async queueState(runtimeSessionId: string) {
    await this.state(runtimeSessionId)
    return {
      steering: [...this.queueMessages.steering],
      followUp: [...this.queueMessages.followUp],
    }
  }

  async clearQueue(runtimeSessionId: string) {
    await this.state(runtimeSessionId)
    const current = {
      steering: [...this.queueMessages.steering],
      followUp: [...this.queueMessages.followUp],
    }
    this.queueMessages.steering.splice(0)
    this.queueMessages.followUp.splice(0)
    return current
  }

  async interrupt(runtimeSessionId: string) {
    await this.state(runtimeSessionId)
    return {
      restoredQueue: {
        steering: [...this.queueMessages.steering],
        followUp: [...this.queueMessages.followUp],
      },
    }
  }

  async terminate(runtimeSessionId: string) {
    await this.state(runtimeSessionId)
    this.runtimes.delete(runtimeSessionId)
  }

  async dispose() {
    this.runtimes.clear()
  }
}

class FakeLiveService implements LiveService {
  constructor(readonly adapter: FakeLiveAdapter) {}

  register(_adapter: LiveAdapter): Disposable {
    throw new Error('register is not used by this test')
  }

  list(): LiveAdapter[] {
    return [this.adapter]
  }

  get(liveId: string): LiveAdapter | null {
    return liveId === this.adapter.manifest.liveId ? this.adapter : null
  }
}

test('generic Live HTTP surface coalesces concurrent identical adapter reads', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const adapter = new FakeLiveAdapter(false, 20)
  const surface = await startHttpSurface(storage, { port: 0, lives: new FakeLiveService(adapter) })
  const base = `http://${surface.host}:${surface.port}`

  try {
    const products = await Promise.all(
      Array.from({ length: 100 }, () => fetch(`${base}/api/v1/live`)),
    )
    assert.equal(products.every(response => response.status === 200), true)
    assert.equal(adapter.readCounts.availability, 1)
    assert.equal(adapter.readCounts.list, 1)

    const started = await fetch(`${base}/api/v1/live/test/runtimes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    })
    assert.equal(started.status, 201)

    adapter.readCounts.state = 0
    adapter.readCounts.snapshot = 0
    const snapshots = await Promise.all(
      Array.from({ length: 100 }, () =>
        fetch(`${base}/api/v1/live/test/runtimes/runtime-1/snapshot`)),
    )
    assert.equal(snapshots.every(response => response.status === 200), true)
    assert.equal(adapter.readCounts.snapshot, 1)
    assert.equal(adapter.readCounts.state, 1)
  } finally {
    await surface.dispose()
    storage.close()
  }
})

test('generic Live HTTP surface controls an adapter without product-specific routes', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const adapter = new FakeLiveAdapter()
  const surface = await startHttpSurface(storage, { port: 0, lives: new FakeLiveService(adapter) })
  const base = `http://${surface.host}:${surface.port}`

  try {
    const products = await fetch(`${base}/api/v1/live`)
    assert.equal(products.status, 200)
    assert.deepEqual(await products.json(), {
      items: [{
        liveId: 'test',
        productId: 'test-agent',
        displayName: 'Test Live',
        capabilities: ['create', 'resume', 'fork', 'send', 'stream', 'interrupt', 'queue', 'command-discovery', 'model-switching', 'extension-ui'],
        inputCapabilities: {
          text: 'native',
          largeText: 'native',
          image: 'unsupported',
          file: 'unsupported',
          multiline: 'native',
        },
        startCapabilities: {
          workspace: 'optional',
          title: 'optional',
        },
        availability: { available: true },
        runtimes: [],
      }],
    })

    const rejectedNativeField = await fetch(`${base}/api/v1/live/test/runtimes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { cwd: '/tmp/native' } }),
    })
    assert.equal(rejectedNativeField.status, 400)

    const started = await fetch(`${base}/api/v1/live/test/runtimes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { workspacePath: '/tmp/project', title: 'Test task' } }),
    })
    assert.equal(started.status, 201)
    const startedState = await started.json() as LiveRuntimeState
    assert.equal(startedState.runtimeSessionId, 'runtime-1')
    assert.equal(startedState.workspacePath, '/tmp/project')

    const state = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/state`)
    assert.equal(state.status, 200)
    assert.equal((await state.json() as LiveRuntimeState).status, 'ready')

    const snapshot = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/snapshot`)
    assert.equal(snapshot.status, 200)
    assert.deepEqual((await snapshot.json() as LiveSnapshot).entries, [{ kind: 'snapshot' }])

    const sent = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })
    assert.equal(sent.status, 202)
    assert.equal(adapter.sent.length, 1)
    assert.deepEqual(adapter.sent[0]?.message, { parts: [{ type: 'text', text: 'hello' }] })

    const unsupportedSteer = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'change course', behavior: 'steer' }),
    })
    assert.equal(unsupportedSteer.status, 409)

    const commands = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/commands`)
    assert.equal(commands.status, 200)
    assert.deepEqual(await commands.json(), {
      items: [
        { value: '/review', label: '/review', description: 'Review changes', group: 'extension' },
        { value: '/skill:repo-review', label: '/skill:repo-review', group: 'skill' },
      ],
    })

    const workspaceReferences = await fetch(
      `${base}/api/v1/live/test/runtimes/runtime-1/workspace-references?q=src&limit=10`,
    )
    assert.equal(workspaceReferences.status, 200)
    assert.deepEqual(await workspaceReferences.json(), {
      items: [{ path: 'src/index.ts', value: '@src/index.ts' }],
    })

    const messageActions = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/message-actions`)
    assert.equal(messageActions.status, 200)
    assert.deepEqual(await messageActions.json(), {
      items: [
        {
          actionId: 'test.rewind',
          label: { default: 'Rewind', localizations: { 'zh-CN': '回到这里', 'en-US': 'Rewind' } },
          roles: ['user'],
          requiresIdle: true,
        },
        {
          actionId: 'test.open',
          label: { default: 'Open', localizations: { 'zh-CN': '打开', 'en-US': 'Open' } },
          roles: ['user'],
          requiresIdle: true,
        },
      ],
    })

    const executedMessageAction = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/message-actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: 'test.rewind', targetEntryId: 'entry-1' }),
    })
    assert.equal(executedMessageAction.status, 200)
    assert.deepEqual(await executedMessageAction.json(), {
      outcome: 'refresh-current',
      draftText: 'restored draft',
    })
    assert.deepEqual(adapter.messageActionExecutions, [{
      runtimeSessionId: 'runtime-1',
      actionId: 'test.rewind',
      targetEntryId: 'entry-1',
    }])

    const openedMessageAction = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/message-actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: 'test.open', targetEntryId: 'entry-1' }),
    })
    assert.equal(openedMessageAction.status, 200)
    assert.deepEqual(await openedMessageAction.json(), {
      outcome: 'open-runtime',
      runtime: {
        runtimeSessionId: 'runtime-1',
        status: 'ready',
        workspacePath: '/tmp/project',
        isStreaming: false,
        pendingMessageCount: 0,
      },
      draftText: 'new draft',
    })

    const rejectedMessageAction = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/message-actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: 'test.rewind' }),
    })
    assert.equal(rejectedMessageAction.status, 400)

    const hiddenMessageAction = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/message-actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: 'test.hidden', targetEntryId: 'entry-1' }),
    })
    assert.equal(hiddenMessageAction.status, 409)
    assert.equal(adapter.messageActionExecutions.length, 2, 'undeclared action must never reach adapter execution')

    const queueState = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/queue`)
    assert.equal(queueState.status, 200)
    assert.deepEqual(await queueState.json(), {
      steering: ['queued steer'],
      followUp: ['queued follow-up'],
    })

    const clearedQueue = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/queue`, { method: 'DELETE' })
    assert.equal(clearedQueue.status, 200)
    assert.deepEqual(await clearedQueue.json(), {
      steering: ['queued steer'],
      followUp: ['queued follow-up'],
    })

    adapter.queueMessages.steering.push('restored steer')
    adapter.queueMessages.followUp.push('restored follow-up')

    const modelControl = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/model-control`)
    assert.equal(modelControl.status, 200)
    assert.equal((await modelControl.json() as LiveModelControl).value, 'model-a')

    const switchedModel = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/model-control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'model-b' }),
    })
    assert.equal(switchedModel.status, 200)
    assert.equal((await adapter.modelControl('runtime-1')).value, 'model-b')

    const extensionResponse = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/extension-response`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'request-1', response: { confirmed: true } }),
    })
    assert.equal(extensionResponse.status, 202)
    assert.deepEqual(adapter.extensionResponses, [{
      runtimeSessionId: 'runtime-1',
      requestId: 'request-1',
      response: { confirmed: true },
    }])

    const interrupted = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/interrupt`, { method: 'POST' })
    assert.equal(interrupted.status, 200)
    assert.deepEqual(await interrupted.json(), {
      restoredQueue: {
        steering: ['restored steer'],
        followUp: ['restored follow-up'],
      },
    })

    const terminated = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1`, { method: 'DELETE' })
    assert.equal(terminated.status, 200)
    assert.equal(adapter.runtimes.size, 0)
  } finally {
    await surface.dispose()
    storage.close()
  }
})

test('generic Live product discovery keeps adapter capabilities when runtime listing fails', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const adapter = new FakeLiveAdapter(true)
  const surface = await startHttpSurface(storage, { port: 0, lives: new FakeLiveService(adapter) })
  const base = `http://${surface.host}:${surface.port}`

  try {
    const response = await fetch(`${base}/api/v1/live`)
    assert.equal(response.status, 200)
    const body = await response.json() as { items: Array<{ capabilities: string[]; availability: { available: boolean }; runtimes: unknown[] }> }
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0]?.availability.available, true)
    assert.equal(body.items[0]?.capabilities.includes('resume'), true)
    assert.deepEqual(body.items[0]?.runtimes, [])
  } finally {
    await surface.dispose()
    storage.close()
  }
})

test('generic Live HTTP surface routes history resume and fork through adapter capabilities', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const adapter = new FakeLiveAdapter()
  const surface = await startHttpSurface(storage, { port: 0, lives: new FakeLiveService(adapter) })
  const base = `http://${surface.host}:${surface.port}`

  try {
    const resumed = await fetch(`${base}/api/v1/live/test/history/logical-1/resume`, { method: 'POST' })
    assert.equal(resumed.status, 201)
    assert.equal((await resumed.json() as LiveRuntimeState).runtimeSessionId, 'runtime-1')

    const forked = await fetch(`${base}/api/v1/live/test/history/logical-1/fork`, { method: 'POST' })
    assert.equal(forked.status, 201)
    assert.equal((await forked.json() as LiveRuntimeState).runtimeSessionId, 'runtime-2')

    assert.deepEqual(adapter.historyInteractions, [
      { action: 'resume', logicalSessionId: 'logical-1' },
      { action: 'fork', logicalSessionId: 'logical-1' },
    ])
  } finally {
    await surface.dispose()
    storage.close()
  }
})

test('generic Live HTTP surface reports unavailable LiveService without falling through', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const surface = await startHttpSurface(storage, { port: 0 })
  const base = `http://${surface.host}:${surface.port}`

  try {
    const response = await fetch(`${base}/api/v1/live`)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'live_unavailable' })
  } finally {
    await surface.dispose()
    storage.close()
  }
})
