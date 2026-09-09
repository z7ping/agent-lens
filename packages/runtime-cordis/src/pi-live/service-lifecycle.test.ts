import assert from 'node:assert/strict'
import test from 'node:test'
import type { PiLiveRecoveryRecord, PiLiveRecoveryStore } from './recovery-store'
import type { PiLiveRuntimeState, PiLiveStartInput } from './types'
import { DefaultPiLiveService } from './service'
import type { PiRuntimeHandle, PiRuntimeHost } from './worker-host'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
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

function handle(id: string, sessionFile?: string): PiRuntimeHandle {
  return {
    processId: 1234,
    state: async () => readyState(id, sessionFile),
    snapshot: async () => ({ state: readyState(id, sessionFile), entries: [], leafId: null }),
    controls: async () => ({ models: [], thinkingLevels: [] }),
    setModel: async () => readyState(id, sessionFile), setThinkingLevel: async () => readyState(id, sessionFile),
    prompt: async () => {}, steer: async () => {}, followUp: async () => {},
    clearQueue: async () => ({ steering: [], followUp: [] }),
    abort: async () => ({ steering: [], followUp: [] }), respondToExtension: async () => {}, terminate: async () => {},
  }
}

class MemoryRecoveryStore implements PiLiveRecoveryStore {
  readonly values = new Map<string, PiLiveRecoveryRecord>()

  async list(): Promise<PiLiveRecoveryRecord[]> {
    return [...this.values.values()].map(item => ({ ...item, input: { ...item.input } }))
  }

  async put(value: PiLiveRecoveryRecord): Promise<void> {
    this.values.set(value.id, { ...value, input: { ...value.input } })
  }

  async remove(id: string): Promise<void> {
    this.values.delete(id)
  }
}

test('Start 立即返回 initializing，后台就绪后原位切换为 ready', async () => {
  const gate = deferred<PiRuntimeHandle>()
  const host: PiRuntimeHost = { start: async () => gate.promise }
  const service = new DefaultPiLiveService(host)
  const before = performance.now()
  const initial = await service.start({ cwd: '/workspace', name: '异步任务' })
  assert.equal(initial.status, 'initializing')
  assert.ok(performance.now() - before < 200)
  gate.resolve(handle(initial.runtimeSessionId))
  await new Promise(resolve => setTimeout(resolve, 0))
  const ready = await service.state(initial.runtimeSessionId)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.processId, 1234)
  await service.dispose()
})

test('initializing 期间 Terminate 会发出取消信号且不留下 Runtime', async () => {
  let aborted = false
  const host: PiRuntimeHost = {
    start: async (_id, _input, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
      throw new Error('cancelled')
    },
  }
  const service = new DefaultPiLiveService(host)
  const initial = await service.start({ cwd: '/workspace' })
  await service.terminate(initial.runtimeSessionId)
  assert.equal(aborted, true)
  assert.deepEqual(await service.list(), [])
})

test('初始化失败保留可诊断状态，并且只允许显式 Retry', async () => {
  let calls = 0
  const host: PiRuntimeHost = {
    start: async id => {
      calls += 1
      if (calls === 1) throw new Error('token=secret initialization failed')
      return handle(id)
    },
  }
  const service = new DefaultPiLiveService(host)
  const initial = await service.start({ cwd: '/workspace' })
  await new Promise(resolve => setTimeout(resolve, 0))
  const failed = await service.state(initial.runtimeSessionId)
  assert.equal(failed.status, 'failed')
  assert.doesNotMatch(failed.error ?? '', /secret/)
  assert.equal((await service.retry(initial.runtimeSessionId)).status, 'initializing')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await service.state(initial.runtimeSessionId)).status, 'ready')
  assert.equal(calls, 2)
  await service.dispose()
})

test('同一 Pi 历史文件重复继续时返回已有 Runtime', async () => {
  const host: PiRuntimeHost = {
    start: async (_id, _input, signal) => new Promise<PiRuntimeHandle>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }),
  }
  const service = new DefaultPiLiveService(host)
  const first = await service.start({ cwd: '/workspace', sessionPath: '/sessions/history.jsonl' })

  const repeated = await service.start({ cwd: '/workspace', sessionPath: '/sessions/history.jsonl' })
  assert.equal(repeated.runtimeSessionId, first.runtimeSessionId)

  await service.terminate(first.runtimeSessionId)
})

test('Daemon dispose 保留 Live Task，下一代 Runtime 使用同一稳定 ID 继续原 Session', async () => {
  const store = new MemoryRecoveryStore()
  let firstTerminateCalls = 0
  const firstHost: PiRuntimeHost = {
    start: async id => ({
      ...handle(id, '/sessions/live.jsonl'),
      terminate: async () => { firstTerminateCalls += 1 },
    }),
  }
  const first = new DefaultPiLiveService(firstHost, store)
  const initial = await first.start({ cwd: '/workspace', name: '可恢复任务', provider: 'deepseek', model: 'v4' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await first.state(initial.runtimeSessionId)).status, 'ready')
  assert.equal(store.values.get(initial.runtimeSessionId)?.input.sessionPath, '/sessions/live.jsonl')

  await first.dispose()
  assert.equal(firstTerminateCalls, 1)
  assert.equal(store.values.has(initial.runtimeSessionId), true)

  let recoveredInput: PiLiveStartInput | undefined
  let promptCalls = 0
  const secondHost: PiRuntimeHost = {
    start: async (id, input) => {
      recoveredInput = input
      return {
        ...handle(id, '/sessions/live.jsonl'),
        prompt: async () => { promptCalls += 1 },
      }
    },
  }
  const second = new DefaultPiLiveService(secondHost, store)
  const recovering = await second.state(initial.runtimeSessionId)
  assert.ok(['initializing', 'ready'].includes(recovering.status))
  await new Promise(resolve => setTimeout(resolve, 0))
  const restored = await second.state(initial.runtimeSessionId)

  assert.equal(restored.runtimeSessionId, initial.runtimeSessionId)
  assert.equal(restored.status, 'ready')
  assert.equal(restored.initializationMessage?.startsWith('Pi Runtime 已恢复'), true)
  assert.equal(recoveredInput?.sessionPath, '/sessions/live.jsonl')
  assert.equal(recoveredInput?.historyAction, 'continue')
  assert.equal(recoveredInput?.provider, undefined)
  assert.equal(recoveredInput?.model, undefined)
  assert.equal(promptCalls, 0)

  await second.terminate(initial.runtimeSessionId)
  assert.equal(store.values.has(initial.runtimeSessionId), false)

  const third = new DefaultPiLiveService(secondHost, store)
  await assert.rejects(() => third.state(initial.runtimeSessionId), /Unknown Pi Live runtime session/)
  await third.dispose()
})

test('分叉后的 Runtime 跨 Daemon 只恢复新 Session，不再次 fork 原 Session', async () => {
  const store = new MemoryRecoveryStore()
  const originalPath = '/sessions/original.jsonl'
  const forkedPath = '/sessions/forked.jsonl'
  let firstInput: PiLiveStartInput | undefined
  const firstHost: PiRuntimeHost = {
    start: async (id, input) => {
      firstInput = input
      return handle(id, input.historyAction === 'fork' ? forkedPath : input.sessionPath)
    },
  }
  const first = new DefaultPiLiveService(firstHost, store)
  const started = await first.start({ cwd: '/workspace', sessionPath: originalPath, historyAction: 'fork' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await first.state(started.runtimeSessionId)).status, 'ready')
  assert.equal(firstInput?.historyAction, 'fork')
  assert.equal(store.values.get(started.runtimeSessionId)?.input.sessionPath, forkedPath)
  assert.equal(store.values.get(started.runtimeSessionId)?.input.historyAction, 'continue')
  await first.dispose()

  let restoredInput: PiLiveStartInput | undefined
  const secondHost: PiRuntimeHost = {
    start: async (id, input) => {
      restoredInput = input
      return handle(id, input.sessionPath)
    },
  }
  const second = new DefaultPiLiveService(secondHost, store)
  await second.state(started.runtimeSessionId)
  await new Promise(resolve => setTimeout(resolve, 0))
  const restored = await second.state(started.runtimeSessionId)

  assert.equal(restored.status, 'ready')
  assert.equal(restored.sessionFile, forkedPath)
  assert.equal(restoredInput?.sessionPath, forkedPath)
  assert.equal(restoredInput?.historyAction, 'continue')
  assert.notEqual(restoredInput?.sessionPath, originalPath)
  await second.terminate(started.runtimeSessionId)
})

test('URL 指向未知 runtimeSessionId 且无 Recovery 时明确不存在，不创建 Worker', async () => {
  const store = new MemoryRecoveryStore()
  let startCalls = 0
  const host: PiRuntimeHost = {
    start: async id => {
      startCalls += 1
      return handle(id, '/sessions/should-not-exist.jsonl')
    },
  }
  const service = new DefaultPiLiveService(host, store)
  await assert.rejects(() => service.state('missing-runtime'), /Unknown Pi Live runtime session/)
  assert.equal(startCalls, 0)
  await service.dispose()
})
