import assert from 'node:assert/strict'
import test from 'node:test'
import { piLiveRuntimePlugin } from './plugin'
import type { PiLiveRecoveryRecord, PiLiveRecoveryStore } from './recovery-store'
import { DefaultPiLiveService } from './service'
import type { PiLiveRuntimeState } from './types'
import type { PiRuntimeHandle, PiRuntimeHost } from './worker-host'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function readyState(id: string, sessionFile: string): PiLiveRuntimeState {
  return {
    runtimeSessionId: id,
    status: 'ready',
    initializationStage: 'ready',
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    leafId: null,
    sessionFile,
    nativeSessionId: 'native-session',
  }
}

function handle(id: string, sessionFile: string, onTerminate: () => void = () => {}): PiRuntimeHandle {
  const state = readyState(id, sessionFile)
  return {
    processId: 1234,
    state: async () => state,
    snapshot: async () => ({ state, entries: [], leafId: null }),
    controls: async () => ({ models: [], thinkingLevels: [] }),
    setModel: async () => state,
    setThinkingLevel: async () => state,
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    clearQueue: async () => ({ steering: [], followUp: [] }),
    abort: async () => ({ steering: [], followUp: [] }),
    respondToExtension: async () => {},
    terminate: async () => { onTerminate() },
  }
}

class GatedRecoveryStore implements PiLiveRecoveryStore {
  readonly values = new Map<string, PiLiveRecoveryRecord>()
  readonly readyCheckpoint = deferred<void>()
  putCalls = 0

  async list(): Promise<PiLiveRecoveryRecord[]> {
    return [...this.values.values()]
  }

  async put(value: PiLiveRecoveryRecord): Promise<void> {
    this.putCalls += 1
    if (this.putCalls === 2) await this.readyCheckpoint.promise
    this.values.set(value.id, { ...value, input: { ...value.input } })
  }

  async remove(id: string): Promise<void> {
    this.values.delete(id)
  }
}

class FailingReadyRecoveryStore implements PiLiveRecoveryStore {
  readonly values = new Map<string, PiLiveRecoveryRecord>()
  putCalls = 0

  async list(): Promise<PiLiveRecoveryRecord[]> {
    return [...this.values.values()]
  }

  async put(value: PiLiveRecoveryRecord): Promise<void> {
    this.putCalls += 1
    if (this.putCalls === 2) throw new Error('checkpoint unavailable')
    this.values.set(value.id, { ...value, input: { ...value.input } })
  }

  async remove(id: string): Promise<void> {
    this.values.delete(id)
  }
}

test('Pi Live Runtime 插件显式声明 storage 注入依赖', () => {
  assert.deepEqual(piLiveRuntimePlugin.inject, ['storage'])
})

test('Pi Live 只有在原生 Session 恢复点持久化后才进入 ready', async () => {
  const store = new GatedRecoveryStore()
  const host: PiRuntimeHost = {
    start: async id => handle(id, '/sessions/live.jsonl'),
  }
  const service = new DefaultPiLiveService(host, store)
  const initial = await service.start({ cwd: '/workspace' })

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(store.putCalls, 2)
  assert.equal((await service.state(initial.runtimeSessionId)).status, 'initializing')

  store.readyCheckpoint.resolve(undefined)
  await new Promise(resolve => setTimeout(resolve, 0))

  const ready = await service.state(initial.runtimeSessionId)
  assert.equal(ready.status, 'ready')
  assert.equal(store.values.get(initial.runtimeSessionId)?.input.sessionPath, '/sessions/live.jsonl')
  assert.equal(store.values.get(initial.runtimeSessionId)?.input.historyAction, 'continue')

  await service.terminate(initial.runtimeSessionId)
})

test('ready 恢复点写入失败时结束 Worker，避免出现不可恢复的假 ready', async () => {
  const store = new FailingReadyRecoveryStore()
  let terminateCalls = 0
  const host: PiRuntimeHost = {
    start: async id => handle(id, '/sessions/live.jsonl', () => { terminateCalls += 1 }),
  }
  const service = new DefaultPiLiveService(host, store)
  const initial = await service.start({ cwd: '/workspace' })

  await new Promise(resolve => setTimeout(resolve, 0))
  const failed = await service.state(initial.runtimeSessionId)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error ?? '', /recovery checkpoint failed/i)
  assert.equal(terminateCalls, 1)

  await service.terminate(initial.runtimeSessionId)
})
