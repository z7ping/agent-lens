import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  PiLiveRuntimeEvent,
  PiLiveRuntimeListener,
  PiLiveService,
  PiLiveStartInput,
  PiLiveStreamingBehavior,
} from '@agent-lens/runtime-cordis'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { startHttpSurface } from './server'

class FakePiLiveService implements PiLiveService {
  readonly runtimeSessionId = 'runtime-1'
  startInput: PiLiveStartInput | null = null
  snapshotSince: string | undefined
  prompts: Array<{ message: string; behavior?: PiLiveStreamingBehavior }> = []
  steering: string[] = []
  followUps: string[] = []
  abortRestoreQueue: boolean | undefined
  extensionResponses: Array<{ requestId: string; response: unknown }> = []
  terminateCalls = 0
  listener: PiLiveRuntimeListener | null = null

  async availability() {
    return { available: true, executable: '/usr/local/bin/pi' }
  }

  async start(input: PiLiveStartInput) {
    this.startInput = input
    return this.state(this.runtimeSessionId)
  }

  async state(runtimeSessionId: string) {
    if (runtimeSessionId !== this.runtimeSessionId) throw new Error(`Unknown Pi Live runtime session: ${runtimeSessionId}`)
    return {
      runtimeSessionId,
      nativeSessionId: 'pi-native-1',
      sessionFile: '/tmp/pi-session.jsonl',
      sessionName: 'AgentLens Pi Live',
      model: { provider: 'test', id: 'model-1' },
      thinkingLevel: 'medium',
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      leafId: 'entry-2',
      processId: 43210,
    }
  }

  async snapshot(runtimeSessionId: string, since?: string) {
    this.snapshotSince = since
    const state = await this.state(runtimeSessionId)
    return {
      state,
      entries: [{ type: 'message', id: 'entry-2', parentId: since ?? null }],
      leafId: 'entry-2',
    }
  }

  async prompt(_runtimeSessionId: string, message: string, behavior?: PiLiveStreamingBehavior) {
    this.prompts.push({ message, ...(behavior ? { behavior } : {}) })
  }

  async steer(_runtimeSessionId: string, message: string) {
    this.steering.push(message)
  }

  async followUp(_runtimeSessionId: string, message: string) {
    this.followUps.push(message)
  }

  async clearQueue() {
    return { steering: ['queued-steer'], followUp: ['queued-follow-up'] }
  }

  async abort(_runtimeSessionId: string, options: { restoreQueue?: boolean } = {}) {
    this.abortRestoreQueue = options.restoreQueue
    return options.restoreQueue === false
      ? { steering: [], followUp: [] }
      : { steering: ['queued-steer'], followUp: ['queued-follow-up'] }
  }

  async respondToExtension(_runtimeSessionId: string, requestId: string, response: unknown) {
    this.extensionResponses.push({ requestId, response })
  }

  subscribe(runtimeSessionId: string, listener: PiLiveRuntimeListener) {
    if (runtimeSessionId !== this.runtimeSessionId) throw new Error(`Unknown Pi Live runtime session: ${runtimeSessionId}`)
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = null
    }
  }

  async terminate(runtimeSessionId: string) {
    if (runtimeSessionId === this.runtimeSessionId) this.terminateCalls += 1
  }

  async dispose() {}

  emit(event: Record<string, unknown>) {
    const value: PiLiveRuntimeEvent = {
      runtimeSessionId: this.runtimeSessionId,
      sequence: 7,
      receivedAt: '2026-08-30T00:00:00.000Z',
      event,
    }
    this.listener?.(value)
  }
}

async function json(response: Response) {
  return await response.json() as Record<string, unknown>
}

test('Pi Live HTTP control surface preserves runtime ownership and validates commands', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const piLive = new FakePiLiveService()
  const surface = await startHttpSurface(storage, { port: 0, piLive })
  const base = `http://${surface.host}:${surface.port}`

  try {
    const availability = await fetch(`${base}/api/v1/pi-live/availability`)
    assert.equal(availability.status, 200)
    assert.deepEqual(await json(availability), { available: true, executable: '/usr/local/bin/pi' })

    const wrongContentType = await fetch(`${base}/api/v1/pi-live`, {
      method: 'POST',
      body: JSON.stringify({ cwd: '/workspace' }),
    })
    assert.equal(wrongContentType.status, 415)

    const started = await fetch(`${base}/api/v1/pi-live`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/workspace', provider: 'test-provider', model: 'test-model', name: 'live-task' }),
    })
    assert.equal(started.status, 201)
    assert.equal((await json(started)).runtimeSessionId, piLive.runtimeSessionId)
    assert.deepEqual(piLive.startInput, {
      cwd: '/workspace',
      provider: 'test-provider',
      model: 'test-model',
      name: 'live-task',
    })

    const snapshot = await fetch(`${base}/api/v1/pi-live/${piLive.runtimeSessionId}/snapshot?since=entry-1`)
    assert.equal(snapshot.status, 200)
    assert.equal(piLive.snapshotSince, 'entry-1')
    assert.equal((await json(snapshot)).leafId, 'entry-2')

    const badBehavior = await fetch(`${base}/api/v1/pi-live/${piLive.runtimeSessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', behavior: 'invalid' }),
    })
    assert.equal(badBehavior.status, 400)

    const prompt = await fetch(`${base}/api/v1/pi-live/${piLive.runtimeSessionId}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', behavior: 'steer' }),
    })
    assert.equal(prompt.status, 202)
    assert.deepEqual(piLive.prompts, [{ message: 'hello', behavior: 'steer' }])

    await fetch(`${base}/api/v1/pi-live/${piLive.runtimeSessionId}/steer`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'change direction' }),
    })
    await fetch(`${base}/api/v1/pi-live/${piLive.runtimeSessionId}/follow-up`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'then summarize' }),
    })
    assert.deepEqual(piLive.steering, ['change direction'])
    assert.deepEqual(piLive.followUps, ['then summarize'])

    const aborted = await fetch(`${base}/api/v1/pi-live/${piLive.runtimeSessionId}/abort`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ restoreQueue: false }),
    })
    assert.equal(aborted.status, 200)
    assert.deepEqual(await json(aborted), { steering: [], followUp: [] })
    assert.equal(piLive.abortRestoreQueue, false)

    const extensionResponse = await fetch(`${base}/api/v1/pi-live/${piLive.runtimeSessionId}/extension-response`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'ui-1', response: { confirmed: true } }),
    })
    assert.equal(extensionResponse.status, 202)
    assert.deepEqual(piLive.extensionResponses, [{ requestId: 'ui-1', response: { confirmed: true } }])

    const controller = new AbortController()
    const events = await fetch(`${base}/api/v1/pi-live/${piLive.runtimeSessionId}/events`, { signal: controller.signal })
    assert.equal(events.status, 200)
    const reader = events.body!.getReader()
    await reader.read() // initial SSE comment
    piLive.emit({ type: 'agent_start' })
    const streamed = new TextDecoder().decode((await reader.read()).value)
    assert.match(streamed, /event: pi-live/)
    assert.match(streamed, /agent_start/)
    controller.abort()
    await reader.cancel().catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(piLive.terminateCalls, 0, 'closing the view/SSE must not terminate the owned Pi runtime')

    const terminated = await fetch(`${base}/api/v1/pi-live/${piLive.runtimeSessionId}`, { method: 'DELETE' })
    assert.equal(terminated.status, 200)
    assert.equal(piLive.terminateCalls, 1)
  } finally {
    await surface.dispose()
    storage.close()
  }
})
