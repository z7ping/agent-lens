import { randomUUID } from 'node:crypto'
import { PiExtensionUiBridge } from './extension-ui-bridge'
import { toPiLiveWireEvent } from './sdk-event'
import {
  findPiExecutable,
  loadInstalledPiSdk,
  resolveInstalledPiSdk,
  type PiSdkLoader,
  type PiSdkModel,
  type PiSdkSession,
} from './sdk-loader'
import type {
  PiLiveAvailability,
  PiLiveControls,
  PiLiveModelOption,
  PiLiveQueueState,
  PiLiveRuntimeEvent,
  PiLiveRuntimeListener,
  PiLiveRuntimeState,
  PiLiveService,
  PiLiveSnapshot,
  PiLiveStartInput,
  PiLiveStreamingBehavior,
} from './types'

interface OwnedRuntime {
  id: string
  session: PiSdkSession
  listeners: Set<PiLiveRuntimeListener>
  sequence: number
  input: PiLiveStartInput
  unsubscribe: () => void
  extensionUi: PiExtensionUiBridge
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function modelOption(model: PiSdkModel): PiLiveModelOption {
  return {
    provider: model.provider,
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
  }
}

export class DefaultPiLiveService implements PiLiveService {
  private readonly runtimes = new Map<string, OwnedRuntime>()
  private disposed = false

  constructor(private readonly loadSdk: PiSdkLoader = loadInstalledPiSdk) {}

  async availability(): Promise<PiLiveAvailability> {
    const executable = await findPiExecutable()
    if (!executable) return { available: false, reason: 'Pi executable was not found in PATH or PI_BIN' }
    try {
      const sdk = await resolveInstalledPiSdk(executable)
      return sdk
        ? { available: true, executable }
        : {
            available: false,
            executable,
            reason: 'Pi was found, but its official @earendil-works/pi-coding-agent SDK could not be located',
          }
    } catch (error) {
      return {
        available: false,
        executable,
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async list(): Promise<PiLiveRuntimeState[]> {
    const states = await Promise.allSettled([...this.runtimes.keys()].map(id => this.state(id)))
    return states.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  }

  async start(input: PiLiveStartInput): Promise<PiLiveRuntimeState> {
    if (this.disposed) throw new Error('Pi Live service is disposed')
    if (!input.cwd) throw new Error('Pi Live requires a working directory')

    const installed = await this.loadSdk(input.executable)
    const sdk = installed.module
    const sessionManager = input.sessionPath
      ? sdk.SessionManager.open(input.sessionPath, input.sessionDir, input.cwd)
      : sdk.SessionManager.create(input.cwd, input.sessionDir)
    const { session } = await sdk.createAgentSession({ cwd: input.cwd, sessionManager })
    const runtimeSessionId = randomUUID()
    const listeners = new Set<PiLiveRuntimeListener>()
    const extensionUi = new PiExtensionUiBridge({
      publish: event => {
        const runtime = this.runtimes.get(runtimeSessionId)
        if (runtime) this.publish(runtime, event)
      },
    })
    const runtime: OwnedRuntime = {
      id: runtimeSessionId,
      session,
      listeners,
      sequence: 0,
      input,
      unsubscribe: () => {},
      extensionUi,
    }
    this.runtimes.set(runtimeSessionId, runtime)

    try {
      runtime.unsubscribe = session.subscribe(event => this.publish(runtime, toPiLiveWireEvent(record(event))))
      await session.bindExtensions({
        uiContext: extensionUi.context,
        mode: 'rpc',
        abortHandler: () => { void session.abort() },
        onError: (value: unknown) => {
          const error = record(value)
          this.publish(runtime, {
            type: 'extension_error',
            ...(typeof error.extensionPath === 'string' ? { extensionPath: error.extensionPath } : {}),
            ...(typeof error.event === 'string' ? { event: error.event } : {}),
            error: error.error instanceof Error ? error.error.message : String(error.error ?? 'Unknown extension error'),
          })
        },
      })
      if (input.name) session.setSessionName(input.name)
      if (input.provider || input.model) {
        await this.selectInitialModel(session, input.provider, input.model)
      }
      return await this.state(runtimeSessionId)
    } catch (error) {
      this.runtimes.delete(runtimeSessionId)
      runtime.unsubscribe()
      extensionUi.dispose()
      session.dispose()
      throw error
    }
  }

  async state(runtimeSessionId: string): Promise<PiLiveRuntimeState> {
    const runtime = this.requireRuntime(runtimeSessionId)
    const session = runtime.session
    return {
      runtimeSessionId,
      nativeSessionId: session.sessionId,
      ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
      ...(session.sessionName ? { sessionName: session.sessionName } : {}),
      ...(session.model ? { model: session.model } : {}),
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      pendingMessageCount: session.pendingMessageCount,
      leafId: session.sessionManager.getLeafId(),
    }
  }

  async snapshot(runtimeSessionId: string, since?: string): Promise<PiLiveSnapshot> {
    const runtime = this.requireRuntime(runtimeSessionId)
    const manager = runtime.session.sessionManager
    const allEntries = manager.getEntries()
    const entries = since
      ? (() => {
          const index = allEntries.findIndex(entry => record(entry).id === since)
          return index >= 0 ? allEntries.slice(index + 1) : allEntries
        })()
      : allEntries
    const leafId = manager.getLeafId()
    const state = await this.state(runtimeSessionId)
    return { state: { ...state, leafId }, entries, leafId }
  }

  async controls(runtimeSessionId: string): Promise<PiLiveControls> {
    const session = this.requireRuntime(runtimeSessionId).session
    const models = await this.availableModels(session)
    return {
      models: models.map(modelOption),
      thinkingLevels: session.getAvailableThinkingLevels(),
    }
  }

  async setModel(runtimeSessionId: string, provider: string, modelId: string): Promise<PiLiveRuntimeState> {
    if (!provider.trim() || !modelId.trim()) throw new Error('Pi model provider and modelId are required')
    const session = this.requireRuntime(runtimeSessionId).session
    const models = await this.availableModels(session, provider.trim())
    const model = models.find(item => item.provider === provider.trim() && item.id === modelId.trim())
    if (!model) throw new Error(`Pi model is not available: ${provider.trim()}/${modelId.trim()}`)
    await session.setModel(model)
    return await this.state(runtimeSessionId)
  }

  async setThinkingLevel(runtimeSessionId: string, level: string): Promise<PiLiveRuntimeState> {
    if (!level.trim()) throw new Error('Pi thinking level is required')
    const session = this.requireRuntime(runtimeSessionId).session
    session.setThinkingLevel(level.trim())
    return await this.state(runtimeSessionId)
  }

  async prompt(runtimeSessionId: string, message: string, behavior?: PiLiveStreamingBehavior): Promise<void> {
    if (!message.trim()) return
    const session = this.requireRuntime(runtimeSessionId).session
    await new Promise<void>((resolveAccepted, rejectAccepted) => {
      let accepted = false
      const accept = () => {
        if (accepted) return
        accepted = true
        resolveAccepted()
      }
      const run = session.prompt(message, {
        ...(behavior ? { streamingBehavior: behavior } : {}),
        source: 'rpc',
        preflightResult: success => {
          if (success) accept()
        },
      })
      void run.then(accept, error => {
        if (!accepted) rejectAccepted(error)
      })
    })
  }

  async steer(runtimeSessionId: string, message: string): Promise<void> {
    if (!message.trim()) return
    await this.requireRuntime(runtimeSessionId).session.steer(message)
  }

  async followUp(runtimeSessionId: string, message: string): Promise<void> {
    if (!message.trim()) return
    await this.requireRuntime(runtimeSessionId).session.followUp(message)
  }

  async clearQueue(runtimeSessionId: string): Promise<PiLiveQueueState> {
    return this.requireRuntime(runtimeSessionId).session.clearQueue()
  }

  async abort(runtimeSessionId: string, options: { restoreQueue?: boolean } = {}): Promise<PiLiveQueueState> {
    const session = this.requireRuntime(runtimeSessionId).session
    const queue = options.restoreQueue === false
      ? { steering: [], followUp: [] }
      : session.clearQueue()
    await session.abort()
    return queue
  }

  async respondToExtension(runtimeSessionId: string, requestId: string, response: unknown): Promise<void> {
    if (!requestId) throw new Error('Pi extension request id is required')
    this.requireRuntime(runtimeSessionId).extensionUi.respond(requestId, response)
  }

  subscribe(runtimeSessionId: string, listener: PiLiveRuntimeListener): () => void {
    const runtime = this.requireRuntime(runtimeSessionId)
    runtime.listeners.add(listener)
    return () => runtime.listeners.delete(listener)
  }

  async terminate(runtimeSessionId: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeSessionId)
    if (!runtime) return
    this.runtimes.delete(runtimeSessionId)
    runtime.listeners.clear()
    runtime.unsubscribe()
    runtime.extensionUi.dispose()
    if (runtime.session.isStreaming) await runtime.session.abort().catch(() => undefined)
    runtime.session.dispose()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const ids = [...this.runtimes.keys()]
    await Promise.allSettled(ids.map(id => this.terminate(id)))
  }

  private requireRuntime(runtimeSessionId: string): OwnedRuntime {
    const runtime = this.runtimes.get(runtimeSessionId)
    if (!runtime) throw new Error(`Unknown Pi Live runtime session: ${runtimeSessionId}`)
    return runtime
  }

  private publish(runtime: OwnedRuntime, event: Record<string, unknown>): void {
    runtime.sequence += 1
    const value: PiLiveRuntimeEvent = {
      runtimeSessionId: runtime.id,
      sequence: runtime.sequence,
      receivedAt: new Date().toISOString(),
      event,
    }
    for (const listener of runtime.listeners) listener(value)
  }

  private async availableModels(session: PiSdkSession, provider?: string): Promise<readonly PiSdkModel[]> {
    const snapshot = session.modelRuntime.getAvailableSnapshot()
    const filtered = provider ? snapshot.filter(model => model.provider === provider) : snapshot
    if (filtered.length) return filtered
    return await session.modelRuntime.getAvailable(provider)
  }

  private async selectInitialModel(
    session: PiSdkSession,
    provider?: string,
    modelId?: string,
  ): Promise<void> {
    const models = await this.availableModels(session, provider)
    const model = models.find(item => {
      if (provider && item.provider !== provider) return false
      if (!modelId) return true
      return item.id === modelId || item.name === modelId
    })
    if (!model) {
      const target = [provider, modelId].filter(Boolean).join('/') || 'requested model'
      throw new Error(`Pi model is not available: ${target}`)
    }
    await session.setModel(model)
  }
}
