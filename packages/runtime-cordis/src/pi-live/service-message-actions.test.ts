import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultPiLiveService } from './service'
import type { PiRuntimeHandle, PiRuntimeHost } from './worker-host'
import type { PiLiveRuntimeCapabilities, PiLiveRuntimeState, PiLiveStartInput } from './types'

const capabilities: PiLiveRuntimeCapabilities = {
  protocolVersion: 1,
  sessionRuntime: true,
  modelSwitching: true,
  thinkingLevelControl: true,
  extensionUi: true,
  treeNavigation: true,
  messageFork: true,
}

interface StartedRuntime {
  runtimeSessionId: string
  input: PiLiveStartInput
}

class MessageActionHost implements PiRuntimeHost {
  readonly starts: StartedRuntime[] = []
  readonly navigated: string[] = []
  isStreaming = false
  entries: unknown[] = [
    {
      type: 'message',
      id: 'u-root',
      parentId: null,
      message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
    },
    {
      type: 'message',
      id: 'a-1',
      parentId: 'u-root',
      message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    },
    {
      type: 'message',
      id: 'u-2',
      parentId: 'a-1',
      message: { role: 'user', content: [{ type: 'text', text: 'second prompt' }] },
    },
  ]

  async start(
    runtimeSessionId: string,
    input: PiLiveStartInput,
    _signal: AbortSignal,
    _onEvent: (event: Record<string, unknown>) => void,
    _onExit: (error: Error) => void,
  ): Promise<PiRuntimeHandle> {
    const startIndex = this.starts.length
    this.starts.push({ runtimeSessionId, input: { ...input } })
    const sessionFile = input.historyAction === 'fork'
      ? `/sessions/fork-${startIndex}.jsonl`
      : input.sessionPath ?? '/sessions/original.jsonl'
    const state = (): PiLiveRuntimeState => ({
      runtimeSessionId,
      status: 'ready',
      capabilities,
      nativeSessionId: `native-${startIndex}`,
      sessionFile,
      isStreaming: startIndex === 0 ? this.isStreaming : false,
      isCompacting: false,
      pendingMessageCount: 0,
      leafId: 'u-2',
    })
    return {
      capabilities,
      state: async () => state(),
      snapshot: async () => ({ state: state(), entries: [...this.entries], leafId: 'u-2' }),
      navigateTree: async entryId => {
        this.navigated.push(entryId)
        return { cancelled: false, editorText: entryId === 'u-2' ? 'second prompt' : 'first prompt' }
      },
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

async function waitForReady(service: DefaultPiLiveService, runtimeSessionId: string) {
  for (let index = 0; index < 100; index += 1) {
    const state = await service.state(runtimeSessionId)
    if (state.status === 'ready') return state
    if (state.status === 'failed') throw new Error(state.error || 'runtime failed')
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('runtime did not become ready')
}

async function startOriginal(service: DefaultPiLiveService) {
  const initial = await service.start({
    cwd: '/workspace',
    sessionPath: '/sessions/original.jsonl',
    historyAction: 'continue',
  })
  return waitForReady(service, initial.runtimeSessionId)
}

test('Pi message actions are declared only for verified idle runtimes', async () => {
  const host = new MessageActionHost()
  const service = new DefaultPiLiveService(host)
  try {
    const original = await startOriginal(service)
    assert.deepEqual(
      (await service.messageActions(original.runtimeSessionId)).map(action => action.actionId),
      ['pi.edit-from-here', 'pi.new-session-from-here'],
    )

    host.isStreaming = true
    assert.deepEqual(await service.messageActions(original.runtimeSessionId), [])
  } finally {
    await service.dispose()
  }
})

test('Edit from here navigates the current Pi session to the exact persisted user entry', async () => {
  const host = new MessageActionHost()
  const service = new DefaultPiLiveService(host)
  try {
    const original = await startOriginal(service)
    const result = await service.executeMessageAction(
      original.runtimeSessionId,
      'pi.edit-from-here',
      'u-2',
    )

    assert.deepEqual(result, {
      outcome: 'refresh-current',
      draftText: 'second prompt',
    })
    assert.deepEqual(host.navigated, ['u-2'])
    assert.equal(host.starts.length, 1, 'Edit from here must not create another Runtime')
  } finally {
    await service.dispose()
  }
})

test('New session forks before the selected user message without mutating the current Runtime', async () => {
  const host = new MessageActionHost()
  const service = new DefaultPiLiveService(host)
  try {
    const original = await startOriginal(service)
    const result = await service.executeMessageAction(
      original.runtimeSessionId,
      'pi.new-session-from-here',
      'u-2',
    )

    assert.equal(result.outcome, 'open-runtime')
    assert.equal(result.draftText, 'second prompt')
    assert.ok(result.runtime)
    assert.notEqual(result.runtime.runtimeSessionId, original.runtimeSessionId)

    for (let index = 0; index < 100 && host.starts.length < 2; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    assert.equal(host.starts.length, 2)
    assert.deepEqual(host.starts[1]?.input, {
      cwd: '/workspace',
      sessionPath: '/sessions/original.jsonl',
      historyAction: 'fork',
      branchFromEntryId: 'a-1',
    })

    const current = await service.state(original.runtimeSessionId)
    assert.equal(current.sessionFile, '/sessions/original.jsonl')
  } finally {
    await service.dispose()
  }
})

test('New session from the first user message preserves a root-fork marker', async () => {
  const host = new MessageActionHost()
  const service = new DefaultPiLiveService(host)
  try {
    const original = await startOriginal(service)
    await service.executeMessageAction(
      original.runtimeSessionId,
      'pi.new-session-from-here',
      'u-root',
    )

    for (let index = 0; index < 100 && host.starts.length < 2; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    assert.equal(host.starts[1]?.input.branchFromEntryId, null)
    assert.equal(host.starts[1]?.input.sessionPath, '/sessions/original.jsonl')
    assert.equal(host.starts[1]?.input.historyAction, 'fork')
  } finally {
    await service.dispose()
  }
})

test('Pi message action execution rejects streaming and non-user targets server-side', async () => {
  const host = new MessageActionHost()
  const service = new DefaultPiLiveService(host)
  try {
    const original = await startOriginal(service)
    host.isStreaming = true
    await assert.rejects(
      () => service.executeMessageAction(original.runtimeSessionId, 'pi.new-session-from-here', 'u-2'),
      /idle session/,
    )

    host.isStreaming = false
    await assert.rejects(
      () => service.executeMessageAction(original.runtimeSessionId, 'pi.edit-from-here', 'a-1'),
      /persisted user message entry/,
    )
  } finally {
    await service.dispose()
  }
})
