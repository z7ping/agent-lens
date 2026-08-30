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
  modelChanges: Array<{ provider: string; modelId: string }> = []
  thinkingChanges: string[] = []
  model = { provider: 'test', id: 'model-1', name: 'Model One' }
  thinkingLevel = 'medium'
  terminateCalls = 0
  listener: PiLiveRuntimeListener | null = null

  async availability() {
    return { available: true, executable: '/usr/local/bin/pi' }
  }

  async list() {
    return [await this.state(this.runtimeSessionId)]
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
      model: this.model,
      thinkingLevel: this.thinkingLevel,
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

  async controls(_runtimeSessionId: string) {
    return {
      models: [
        { provider: 'test', id: 'model-1', name: 'Model One', reasoning: true },
        { provider: 'test', id: 'model-2', name: 'Model Two', reasoning: true },
      ],
      thinkingLevels: ['off', 'low', 'medium', 'high'],
    }
  }

  async setModel(runtimeSessionId: string, provider: string, modelId: string) {
    this.modelChanges.push({ provider, modelId })
    this.model = { provider, id: modelId, name: modelId === 'model-2' ? 'Model Two' : modelId }
    return this.state(runtimeSessionId)
  }

  async setThinkingLevel(runtimeSessionId: string, level: string) {
    this.thinkingChanges.push(level)
    this.thinkingLevel = level
    return this.state(runtimeSessionId)
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

    const runtimes = await fetch(`${base}/api/v1/pi-live`)
    assert.equal(runtimes.status, 200)
    const runtimeList = await runtimes.json() as Array<Record<string, unknown>>
    assert.equal(runtimeList.length, 1)
    assert.equal(runtimeList[0]?.runtimeSessionId, piLive.runtimeSessionId)

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

    const controls = await fetch(`${base}/api/v1/pi-live/${piLive.runtimeSessionId}/controls`)
    assert.equal(controls.status, 200)
    assert.deepEqual(await json(controls), {
      models: [
        { provider: 'test', id: 'model-1', name: 'Model One', reasoning: true },
        { provider: 'test', id: 'model-2', name: 'Model Two', reasoning: true },
      ],
      thinkingLevels: ['off', 'low', 'medium', 'high'],
    })

    const changedModel = await fetch(`${base}/api/v1/pi-live/${piLive.runtimeSessionId}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'test', modelId: 'model-2' }),
    })
    assert.equal(changedModel.status, 200)
    assert.deepEqual(piLive.modelChanges, [{ provider: 'test', modelId: 'model-2' }])
    assert.deepEqual((await json(changedModel)).model, { provider: 'test', id: 'model-2', name: 'Model Two' })

    const changedThinking = await fetch(`${base}/api/v1/pi-live/${piLive.runtimeSessionId}/thinking-level`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 'high' }),
    })
    assert.equal(changedThinking.status, 200)
    assert.deepEqual(piLive.thinkingChanges, ['high'])
    assert.equal((await json(changedThinking)).thinkingLevel, 'high')

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
    await reader.read()
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
