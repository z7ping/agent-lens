import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultPiLiveService } from './service'
import type { PiRuntimeHandle, PiRuntimeHost } from './worker-host'
import type { PiLiveRuntimeState, PiLiveStartInput } from './types'

interface StartCall {
  runtimeSessionId: string
  input: PiLiveStartInput
  exit(error: Error): void
}

function readyState(runtimeSessionId: string, sessionFile: string): PiLiveRuntimeState {
  return {
    runtimeSessionId,
    status: 'ready',
    nativeSessionId: sessionFile.includes('forked') ? 'forked-native' : 'original-native',
    sessionFile,
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    leafId: 'leaf-1',
  }
}

class HistoryHost implements PiRuntimeHost {
  readonly starts: StartCall[] = []

  async start(
    runtimeSessionId: string,
    input: PiLiveStartInput,
    _signal: AbortSignal,
    _onEvent: (event: Record<string, unknown>) => void,
    onExit: (error: Error) => void,
  ): Promise<PiRuntimeHandle> {
    const snapshot = { ...input }
    this.starts.push({ runtimeSessionId, input: snapshot, exit: onExit })
    const sessionFile = input.historyAction === 'fork'
      ? '/sessions/forked.jsonl'
      : input.sessionPath ?? '/sessions/new.jsonl'
    const state = () => readyState(runtimeSessionId, sessionFile)
    return {
      state: async () => state(),
      snapshot: async () => ({ state: state(), entries: [], leafId: 'leaf-1' }),
      controls: async () => ({ models: [], thinkingLevels: [] }),
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

async function waitForStatus(service: DefaultPiLiveService, id: string, status: PiLiveRuntimeState['status']): Promise<PiLiveRuntimeState> {
  for (let index = 0; index < 100; index += 1) {
    const state = await service.state(id)
    if (state.status === status) return state
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`runtime ${id} did not reach ${status}`)
}

test('分叉成功后锁转移到新 Session，原 Session 可再次启动且重试不会重复分叉', async () => {
  const host = new HistoryHost()
  const service = new DefaultPiLiveService(host)
  try {
    const originalPath = '/sessions/original.jsonl'
    const forked = await service.start({ cwd: '/workspace', sessionPath: originalPath, historyAction: 'fork' })
    await waitForStatus(service, forked.runtimeSessionId, 'ready')

    await assert.rejects(
      () => service.start({ cwd: '/workspace', sessionPath: '/sessions/forked.jsonl', historyAction: 'continue' }),
      /已经在进行中/,
    )

    const original = await service.start({ cwd: '/workspace', sessionPath: originalPath, historyAction: 'continue' })
    await waitForStatus(service, original.runtimeSessionId, 'ready')
    await service.terminate(original.runtimeSessionId)

    const firstForkStart = host.starts.find(item => item.runtimeSessionId === forked.runtimeSessionId)
    assert.ok(firstForkStart)
    firstForkStart.exit(new Error('worker exited'))
    await waitForStatus(service, forked.runtimeSessionId, 'failed')
    await service.retry(forked.runtimeSessionId)
    await waitForStatus(service, forked.runtimeSessionId, 'ready')

    const retryStarts = host.starts.filter(item => item.runtimeSessionId === forked.runtimeSessionId)
    assert.equal(retryStarts.length, 2)
    assert.equal(retryStarts[0]?.input.sessionPath, originalPath)
    assert.equal(retryStarts[0]?.input.historyAction, 'fork')
    assert.equal(retryStarts[1]?.input.sessionPath, '/sessions/forked.jsonl')
    assert.equal(retryStarts[1]?.input.historyAction, 'continue')
  } finally {
    await service.dispose()
  }
})
