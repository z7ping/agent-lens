import assert from 'node:assert/strict'
import test from 'node:test'
import type { PiLiveSnapshotDto } from '@agent-lens/protocol'
import { PiLiveApi } from './pi-live'

class FakeEventSource {
  static latest: FakeEventSource | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(readonly url: string) {
    FakeEventSource.latest = this
  }

  addEventListener(): void {}
  close(): void { this.closed = true }
}

function installDocument(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
    },
  })
  return () => {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor)
    else delete (globalThis as { document?: unknown }).document
  }
}

function installEventSource(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventSource')
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeEventSource })
  return () => {
    FakeEventSource.latest = null
    if (descriptor) Object.defineProperty(globalThis, 'EventSource', descriptor)
    else delete (globalThis as { EventSource?: unknown }).EventSource
  }
}

test('Pi Live SSE 断开后 Runtime 404 会结束无限重连并发布不可恢复状态', async () => {
  const previousFetch = globalThis.fetch
  const restoreDocument = installDocument()
  const restoreEventSource = installEventSource()
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'not_found' }),
    } as Response),
  })

  const snapshots: PiLiveSnapshotDto[] = []
  const errors: Error[] = []
  const connections: boolean[] = []
  try {
    const api = new PiLiveApi()
    const dispose = api.connect('live-task', {
      onEvents() {},
      onConnection(value) { connections.push(value) },
      onSnapshot(value) { snapshots.push(value) },
      onError(error) { errors.push(error) },
    })
    const source = FakeEventSource.latest
    assert.ok(source)
    source.onerror?.()
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.deepEqual(connections, [false])
    assert.equal(source.closed, true)
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0]?.state.runtimeSessionId, 'live-task')
    assert.equal(snapshots[0]?.state.status, 'failed')
    assert.match(snapshots[0]?.state.error ?? '', /无法恢复|持久状态/)
    assert.equal(errors.length, 1)

    dispose()
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previousFetch })
    restoreEventSource()
    restoreDocument()
  }
})

test('Pi Live SSE 临时断线且 Daemon 不可达时保留 EventSource 自动重连', async () => {
  const previousFetch = globalThis.fetch
  const restoreDocument = installDocument()
  const restoreEventSource = installEventSource()
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => { throw new TypeError('network unavailable') },
  })

  const errors: Error[] = []
  try {
    const api = new PiLiveApi()
    const dispose = api.connect('live-task', {
      onEvents() {},
      onConnection() {},
      onError(error) { errors.push(error) },
    })
    const source = FakeEventSource.latest
    assert.ok(source)
    source.onerror?.()
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.equal(source.closed, false)
    assert.deepEqual(errors, [])

    dispose()
  } finally {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: previousFetch })
    restoreEventSource()
    restoreDocument()
  }
})
