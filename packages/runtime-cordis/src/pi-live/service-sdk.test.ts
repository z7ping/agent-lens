import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectPiSdkCompatibility } from './pi-sdk-adapter'
import { DefaultPiLiveService } from './service'
import type {
  InstalledPiSdk,
  PiSdkModel,
  PiSdkSession,
  PiSdkSessionManager,
} from './sdk-loader'

class FakeSessionManager implements PiSdkSessionManager {
  readonly entries: unknown[] = [{ type: 'message', id: 'entry-1' }]
  getSessionId(): string { return 'native-session-1' }
  getSessionFile(): string { return '/sessions/native-session-1.jsonl' }
  getSessionName(): string { return 'SDK task' }
  getLeafId(): string { return 'entry-1' }
  getEntries(): unknown[] { return [...this.entries] }
}

type PiSdkEventListener = Parameters<PiSdkSession['subscribe']>[0]
type PiSdkEvent = Parameters<PiSdkEventListener>[0]

function emit(listener: PiSdkEventListener | undefined, event: Record<string, unknown>): void {
  listener?.(event as PiSdkEvent)
}

function compatibility(version = '0.84.4') {
  return inspectPiSdkCompatibility(version)
}

async function waitUntilReady(service: DefaultPiLiveService, runtimeSessionId: string) {
  for (let index = 0; index < 50; index += 1) {
    const state = await service.state(runtimeSessionId)
    if (state.status === 'ready') return state
    if (state.status === 'failed') throw new Error(state.error || 'Pi Live initialization failed')
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('Pi Live initialization did not finish')
}

test('Pi Live 通过官方 AgentSession SDK 驱动并保持现有事件/Extension UI Contract', async () => {
  const manager = new FakeSessionManager()
  const models: PiSdkModel[] = [{ provider: 'openai', id: 'gpt-test', name: 'GPT Test', reasoning: true }]
  let agentListener: PiSdkEventListener | undefined
  let bindings: Parameters<PiSdkSession['bindExtensions']>[0] | undefined
  const calls: string[] = []
  let currentModel: PiSdkModel | undefined = models[0]
  let name = 'SDK task'
  let streaming = false
  let releasePrompt: (() => void) | undefined

  const session: PiSdkSession = {
    sessionManager: manager,
    get sessionId() { return manager.getSessionId() },
    get sessionFile() { return manager.getSessionFile() },
    get sessionName() { return name },
    get model() { return currentModel },
    thinkingLevel: 'medium',
    get isStreaming() { return streaming },
    isCompacting: false,
    pendingMessageCount: 0,
    modelRuntime: {
      getAvailableSnapshot: () => models,
      getAvailable: async () => models,
    },
    bindExtensions: async value => { bindings = value },
    subscribe: listener => {
      agentListener = listener
      return () => { agentListener = undefined }
    },
    setSessionName: value => { name = value },
    setModel: async model => { currentModel = model; calls.push(`model:${model.provider}/${model.id}`) },
    setThinkingLevel: level => { calls.push(`thinking:${level}`) },
    getAvailableThinkingLevels: () => ['off', 'medium', 'high'],
    prompt: async (message, options) => {
      calls.push(`prompt:${message}:${options?.streamingBehavior ?? 'direct'}:${options?.source ?? 'none'}`)
      streaming = true
      options?.preflightResult?.(true)
      await new Promise<void>(resolve => { releasePrompt = resolve })
      streaming = false
    },
    steer: async message => { calls.push(`steer:${message}`) },
    followUp: async message => { calls.push(`follow:${message}`) },
    clearQueue: () => ({ steering: ['queued-steer'], followUp: ['queued-follow'] }),
    abort: async () => { streaming = false; releasePrompt?.(); calls.push('abort') },
    waitForIdle: async () => {},
    dispose: () => { releasePrompt?.(); calls.push('dispose') },
  }

  const installed: InstalledPiSdk = {
    executable: '/bin/pi',
    packageRoot: '/node_modules/@earendil-works/pi-coding-agent',
    sdkEntry: '/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
    version: '0.84.4',
    compatibility: compatibility(),
    module: {
      createAgentSession: async () => ({ session }),
      SessionManager: {
        create: () => manager,
        open: () => manager,
      },
    },
  }

  const service = new DefaultPiLiveService(async () => installed)
  const initializing = await service.start({ cwd: '/workspace', provider: 'openai', model: 'gpt-test', name: 'AgentLens task' })
  assert.equal(initializing.status, 'initializing')
  const state = await waitUntilReady(service, initializing.runtimeSessionId)
  assert.equal(state.nativeSessionId, 'native-session-1')
  assert.equal(state.sessionName, 'AgentLens task')
  assert.equal(state.processId, undefined)
  assert.equal(calls.includes('model:openai/gpt-test'), true)

  const events: Record<string, unknown>[] = []
  const unsubscribe = service.subscribe(state.runtimeSessionId, event => events.push(event.event))
  emit(agentListener, { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read' })
  assert.equal(events.some(event => event.type === 'tool_execution_start'), true)

  emit(agentListener, {
    type: 'message_update',
    message: { role: 'assistant', usage: { output: 7 } },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'hello',
      partial: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    },
  })
  const messageUpdate = events.find(event => event.type === 'message_update')
  assert.deepEqual(messageUpdate, {
    type: 'message_update',
    usage: { output: 7 },
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' },
  })

  emit(agentListener, {
    type: 'message_update',
    message: { role: 'assistant', usage: { output: 8 } },
    assistantMessageEvent: {
      type: 'toolcall_start',
      contentIndex: 1,
      partial: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
        ],
      },
    },
  })
  const toolCallUpdate = events.find(event => {
    const assistant = event.assistantMessageEvent
    return event.type === 'message_update'
      && assistant && typeof assistant === 'object'
      && (assistant as Record<string, unknown>).type === 'toolcall_start'
  })
  assert.deepEqual(toolCallUpdate, {
    type: 'message_update',
    usage: { output: 8 },
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'call-1', toolName: 'read' },
  })

  let promptFinished = false
  const promptRequest = service.prompt(state.runtimeSessionId, 'hello', 'followUp').then(() => { promptFinished = true })
  await promptRequest
  assert.equal(promptFinished, true, 'HTTP-facing prompt should resolve after SDK preflight, before the agent turn completes')
  assert.equal(streaming, true, 'agent turn should still be running after prompt acknowledgement')
  assert.equal(calls.includes('prompt:hello:followUp:rpc'), true)

  await service.steer(state.runtimeSessionId, 'change direction')
  await service.followUp(state.runtimeSessionId, 'afterwards')
  assert.equal(calls.includes('steer:change direction'), true)
  assert.equal(calls.includes('follow:afterwards'), true)

  const ui = bindings?.uiContext as unknown as Record<string, unknown> | undefined
  assert.ok(ui)
  const confirm = ui.confirm as ((title: string, message: string) => Promise<boolean>) | undefined
  assert.ok(confirm)
  const confirmedPromise = confirm('Dangerous action', 'Continue?')
  const request = events.find(event => event.type === 'extension_ui_request' && event.method === 'confirm')
  assert.equal(typeof request?.id, 'string')
  await service.respondToExtension(state.runtimeSessionId, request!.id as string, { confirmed: true })
  assert.equal(await confirmedPromise, true)

  const queue = await service.abort(state.runtimeSessionId)
  assert.deepEqual(queue, { steering: ['queued-steer'], followUp: ['queued-follow'] })

  unsubscribe()
  await service.terminate(state.runtimeSessionId)
  assert.equal(calls.includes('dispose'), true)
})

test('Pi Live SDK prompt 在预检失败时向 HTTP 调用方返回错误', async () => {
  const manager = new FakeSessionManager()
  const session = {
    sessionManager: manager,
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    sessionName: manager.getSessionName(),
    model: undefined,
    thinkingLevel: 'off',
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    modelRuntime: { getAvailableSnapshot: () => [], getAvailable: async () => [] },
    bindExtensions: async () => {},
    subscribe: () => () => {},
    setSessionName: () => {},
    setModel: async () => {},
    setThinkingLevel: () => {},
    getAvailableThinkingLevels: () => ['off'],
    prompt: async (_message: string, options?: { preflightResult?: (success: boolean) => void }) => {
      options?.preflightResult?.(false)
      throw new Error('No model selected')
    },
    steer: async () => {},
    followUp: async () => {},
    clearQueue: () => ({ steering: [], followUp: [] }),
    abort: async () => {},
    waitForIdle: async () => {},
    dispose: () => {},
  } satisfies PiSdkSession
  const installed: InstalledPiSdk = {
    executable: '/bin/pi',
    packageRoot: '/pi',
    sdkEntry: '/pi/dist/index.js',
    version: '0.84.4',
    compatibility: compatibility(),
    module: {
      createAgentSession: async () => ({ session }),
      SessionManager: { create: () => manager, open: () => manager },
    },
  }
  const service = new DefaultPiLiveService(async () => installed)
  const initializing = await service.start({ cwd: '/workspace' })
  const state = await waitUntilReady(service, initializing.runtimeSessionId)
  await assert.rejects(() => service.prompt(state.runtimeSessionId, 'hello'), /No model selected/)
  await service.dispose()
})
