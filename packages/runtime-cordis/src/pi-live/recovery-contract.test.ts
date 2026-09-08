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

function readyState(id: string, sessionFile?: string): PiLiveRuntimeState {
  return {
    runtimeSessionId: id,
    status: 'ready',
    initializationStage: 'ready',
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    leafId: null,
    ...(sessionFile ? { sessionFile, nativeSessionId: 'native-session' } : {}),
  }
}

function handle(
  id: string,
  sessionFile?: string,
  options: { onPrompt?: () => void; onTerminate?: () => void } = {},
): PiRuntimeHandle {
  const state = readyState(id, sessionFile)
  return {
    processId: 1234,
    state: async () => state,
    snapshot: async () => ({ state, entries: [], leafId: null }),
    controls: async () => ({ models: [], thinkingLevels: [] }),
    setModel: async () => state,
    setThinkingLevel: async () => state,
    prompt: async () => { options.onPrompt?.() },
    steer: async () => {},
    followUp: async () => {},
    clearQueue: async () => ({ steering: [], followUp: [] }),
    abort: async () => ({ steering: [], followUp: [] }),
    respondToExtension: async () => {},
    terminate: async () => { options.onTerminate?.() },
  }
}

class GatedRecoveryStore implements PiLiveRecoveryStore {
  readonly values = new Map<string, PiLiveRecoveryRecord>()
  readonly checkpoint = deferred<void>()
  putCalls = 0

  async list(): Promise<PiLiveRecoveryRecord[]> {
    return [...this.values.values()]
  }

  async put(value: PiLiveRecoveryRecord): Promise<void> {
    this.putCalls += 1
    await this.checkpoint.promise
    this.values.set(value.id, { ...value, input: { ...value.input } })
  }

  async remove(id: string): Promise<void> {
    this.values.delete(id)
  }
}

class FailingRecoveryStore implements PiLiveRecoveryStore {
  putCalls = 0

  async list(): Promise<PiLiveRecoveryRecord[]> {
    return []
  }

  async put(): Promise<void> {
    this.putCalls += 1
    throw new Error('checkpoint unavailable')
  }

  async remove(): Promise<void> {}
}

class MemoryRecoveryStore implements PiLiveRecoveryStore {
  readonly values = new Map<string, PiLiveRecoveryRecord>()
  putCalls = 0

  async list(): Promise<PiLiveRecoveryRecord[]> {
    return [...this.values.values()]
  }

  async put(value: PiLiveRecoveryRecord): Promise<void> {
    this.putCalls += 1
    this.values.set(value.id, { ...value, input: { ...value.input } })
  }

  async remove(id: string): Promise<void> {
    this.values.delete(id)
  }
}

test('Pi Live Runtime 插件显式声明 storage 注入依赖', () => {
  assert.deepEqual(piLiveRuntimePlugin.inject, ['storage'])
})

test('新建 Runtime 可交互就绪不等待 Recovery checkpoint', async () => {
  const store = new GatedRecoveryStore()
  let promptCalls = 0
  const host: PiRuntimeHost = {
    start: async id => handle(id, '/sessions/live.jsonl', { onPrompt: () => { promptCalls += 1 } }),
  }
  const service = new DefaultPiLiveService(host, store)
  const initial = await service.start({ cwd: '/workspace' })
  assert.ok(initial.startedAt)

  await new Promise(resolve => setTimeout(resolve, 0))
  const ready = await service.state(initial.runtimeSessionId)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.startedAt, initial.startedAt)
  assert.equal(store.putCalls, 1)

  await service.prompt(initial.runtimeSessionId, 'hello')
  assert.equal(promptCalls, 1)
  assert.equal(store.values.has(initial.runtimeSessionId), false)

  store.checkpoint.resolve(undefined)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(store.values.get(initial.runtimeSessionId)?.createdAt, initial.startedAt)
  assert.equal(store.values.get(initial.runtimeSessionId)?.input.sessionPath, '/sessions/live.jsonl')
  assert.equal(store.values.get(initial.runtimeSessionId)?.input.historyAction, 'continue')

  await service.terminate(initial.runtimeSessionId)
})

test('Recovery checkpoint 写失败不终止已经可交互的 Runtime', async () => {
  const store = new FailingRecoveryStore()
  let promptCalls = 0
  let terminateCalls = 0
  const host: PiRuntimeHost = {
    start: async id => handle(id, '/sessions/live.jsonl', {
      onPrompt: () => { promptCalls += 1 },
      onTerminate: () => { terminateCalls += 1 },
    }),
  }
  const service = new DefaultPiLiveService(host, store)
  const initial = await service.start({ cwd: '/workspace' })

  await new Promise(resolve => setTimeout(resolve, 0))
  const ready = await service.state(initial.runtimeSessionId)
  assert.equal(ready.status, 'ready')
  await service.prompt(initial.runtimeSessionId, 'still works')
  assert.equal(promptCalls, 1)
  assert.equal(terminateCalls, 0)
  assert.ok(store.putCalls >= 1)

  await service.terminate(initial.runtimeSessionId)
  assert.equal(terminateCalls, 1)
})

test('新建 Runtime 暂无 sessionFile 时仍 ready 且不制造伪 Recovery Record', async () => {
  const store = new MemoryRecoveryStore()
  let promptCalls = 0
  const host: PiRuntimeHost = {
    start: async id => handle(id, undefined, { onPrompt: () => { promptCalls += 1 } }),
  }
  const service = new DefaultPiLiveService(host, store)
  const initial = await service.start({ cwd: '/workspace' })

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await service.state(initial.runtimeSessionId)).status, 'ready')
  await service.prompt(initial.runtimeSessionId, 'hello')
  assert.equal(promptCalls, 1)
  assert.equal(store.putCalls, 0)
  assert.equal(store.values.size, 0)

  await service.terminate(initial.runtimeSessionId)
})
