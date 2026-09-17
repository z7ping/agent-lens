import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  Disposable,
  LiveAdapter,
  LiveAdapterManifest,
  LiveCapabilityName,
  LiveMessageInput,
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
    capabilities: ['create', 'send', 'stream', 'interrupt'],
  }
  readonly capabilities: ReadonlySet<LiveCapabilityName> = new Set(['create', 'send', 'stream', 'interrupt'])
  readonly inputCapabilities = {
    text: 'native' as const,
    largeText: 'native' as const,
    image: 'unsupported' as const,
    file: 'unsupported' as const,
    multiline: 'native' as const,
  }
  readonly sent: Array<{ runtimeSessionId: string; message: LiveMessageInput; options?: LiveSendOptions | undefined }> = []
  readonly runtimes = new Map<string, LiveRuntimeState>()
  private sequence = 0

  async availability() {
    return { available: true }
  }

  async list() {
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

  async state(runtimeSessionId: string) {
    const state = this.runtimes.get(runtimeSessionId)
    if (!state) throw new Error(`Unknown Live runtime: ${runtimeSessionId}`)
    return state
  }

  async snapshot(runtimeSessionId: string): Promise<LiveSnapshot> {
    return { state: await this.state(runtimeSessionId), entries: [{ kind: 'snapshot' }] }
  }

  async send(runtimeSessionId: string, message: LiveMessageInput, options?: LiveSendOptions) {
    await this.state(runtimeSessionId)
    this.sent.push({ runtimeSessionId, message, ...(options ? { options } : {}) })
  }

  subscribe(runtimeSessionId: string, _listener: (event: LiveRuntimeEvent) => void) {
    void this.state(runtimeSessionId)
    return () => undefined
  }

  async interrupt(runtimeSessionId: string) {
    await this.state(runtimeSessionId)
    return { interrupted: true }
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
        capabilities: ['create', 'send', 'stream', 'interrupt'],
        inputCapabilities: {
          text: 'native',
          largeText: 'native',
          image: 'unsupported',
          file: 'unsupported',
          multiline: 'native',
        },
        availability: { available: true },
        runtimes: [],
      }],
    })

    const started = await fetch(`${base}/api/v1/live/test/runtimes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { workspacePath: '/tmp/project' } }),
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

    const interrupted = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1/interrupt`, { method: 'POST' })
    assert.equal(interrupted.status, 200)
    assert.deepEqual(await interrupted.json(), { interrupted: true })

    const terminated = await fetch(`${base}/api/v1/live/test/runtimes/runtime-1`, { method: 'DELETE' })
    assert.equal(terminated.status, 200)
    assert.equal(adapter.runtimes.size, 0)
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
