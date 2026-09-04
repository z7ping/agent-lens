import { randomUUID } from 'node:crypto'
import { findPiExecutable, type PiSdkLoader } from './sdk-loader'
import { InProcessPiRuntimeHost } from './in-process-host'
import { WorkerPiRuntimeHost, type PiRuntimeHandle, type PiRuntimeHost } from './worker-host'
import type { PiLiveAvailability, PiLiveControls, PiLiveInitializationStage, PiLiveInitializationTiming, PiLiveQueueState, PiLiveRuntimeCapabilities, PiLiveRuntimeEvent, PiLiveRuntimeListener, PiLiveRuntimeState, PiLiveService, PiLiveSnapshot, PiLiveStartInput, PiLiveStartupResources, PiLiveStreamingBehavior } from './types'

interface OwnedRuntime {
  id: string
  input: PiLiveStartInput
  status: PiLiveRuntimeState['status']
  stage: PiLiveInitializationStage
  message: string
  error?: string | undefined
  handle?: PiRuntimeHandle | undefined
  listeners: Set<PiLiveRuntimeListener>
  sequence: number
  generation: number
  initialization: AbortController
  initializationStartedAt: number
  stageStartedAt: number
  initializationElapsedMs: number
  initializationTimings: PiLiveInitializationTiming[]
  startupResources?: PiLiveStartupResources | undefined
  startupOutput: string[]
  capabilities?: PiLiveRuntimeCapabilities | undefined
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:api[_-]?key|token|authorization|password)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 2_000)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function formatElapsed(elapsedMs: number): string {
  return elapsedMs < 1_000 ? `${elapsedMs}ms` : `${(elapsedMs / 1_000).toFixed(1)}s`
}

function textList(value: unknown, limit = 240): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, limit)
}

function startupResources(value: unknown): PiLiveStartupResources | undefined {
  const resources = record(value)
  const result: PiLiveStartupResources = {
    contexts: textList(resources.contexts),
    skills: textList(resources.skills),
    prompts: textList(resources.prompts),
    extensions: textList(resources.extensions),
    themes: textList(resources.themes),
    diagnostics: textList(resources.diagnostics, 80),
  }
  return Object.values(result).some(items => items.length) ? result : undefined
}

function runtimeCapabilities(value: unknown): PiLiveRuntimeCapabilities | undefined {
  const capabilities = record(value)
  if (typeof capabilities.protocolVersion !== 'number') return undefined
  if (typeof capabilities.sessionRuntime !== 'boolean' || typeof capabilities.modelSwitching !== 'boolean' || typeof capabilities.thinkingLevelControl !== 'boolean' || typeof capabilities.extensionUi !== 'boolean') return undefined
  return {
    protocolVersion: capabilities.protocolVersion,
    ...(typeof capabilities.sdkVersion === 'string' ? { sdkVersion: capabilities.sdkVersion.slice(0, 80) } : {}),
    sessionRuntime: capabilities.sessionRuntime,
    modelSwitching: capabilities.modelSwitching,
    thinkingLevelControl: capabilities.thinkingLevelControl,
    extensionUi: capabilities.extensionUi,
  }
}

export class DefaultPiLiveService implements PiLiveService {
  private readonly runtimes = new Map<string, OwnedRuntime>()
  private readonly host: PiRuntimeHost
  private availabilityPromise: Promise<PiLiveAvailability> | null = null
  private disposed = false

  constructor(dependency?: PiSdkLoader | PiRuntimeHost) {
    this.host = typeof dependency === 'function' ? new InProcessPiRuntimeHost(dependency) : dependency ?? new WorkerPiRuntimeHost()
  }

  async availability(): Promise<PiLiveAvailability> {
    if (!this.availabilityPromise) {
      this.availabilityPromise = findPiExecutable().then(executable => executable
        ? { available: true, executable }
        : { available: false, reason: 'Pi executable was not found in PATH or PI_BIN' })
    }
    return this.availabilityPromise
  }

  /** Worker 自己加载 SDK，Daemon 只预热可执行文件探测。 */
  async preload(): Promise<void> { await this.availability() }

  async list(): Promise<PiLiveRuntimeState[]> { return Promise.all([...this.runtimes.values()].map(runtime => this.runtimeState(runtime))) }

  async start(input: PiLiveStartInput): Promise<PiLiveRuntimeState> {
    if (this.disposed) throw new Error('Pi Live service is disposed')
    if (!input.cwd.trim()) throw new Error('Pi Live requires a working directory')
    const id = randomUUID()
    const now = Date.now()
    const runtime: OwnedRuntime = {
      id,
      input,
      status: 'initializing',
      stage: 'starting_worker',
      message: '正在启动独立 Pi Runtime Worker',
      listeners: new Set(),
      sequence: 0,
      generation: 1,
      initialization: new AbortController(),
      initializationStartedAt: now,
      stageStartedAt: now,
      initializationElapsedMs: 0,
      initializationTimings: [],
      startupOutput: [],
    }
    this.runtimes.set(id, runtime)
    void this.initialize(runtime, runtime.generation)
    return this.runtimeState(runtime)
  }

  async retry(runtimeSessionId: string): Promise<PiLiveRuntimeState> {
    const runtime = this.requireRuntime(runtimeSessionId)
    if (runtime.status !== 'failed') throw this.conflict('Pi Live runtime can only retry after initialization failed')
    const now = Date.now()
    runtime.generation += 1
    runtime.initialization = new AbortController()
    runtime.status = 'initializing'
    runtime.stage = 'starting_worker'
    runtime.message = '正在重新启动独立 Pi Runtime Worker'
    runtime.error = undefined
    runtime.handle = undefined
    runtime.initializationStartedAt = now
    runtime.stageStartedAt = now
    runtime.initializationElapsedMs = 0
    runtime.initializationTimings = []
    runtime.startupResources = undefined
    runtime.startupOutput = []
    runtime.capabilities = undefined
    this.publish(runtime, { type: 'runtime_status', status: runtime.status, stage: runtime.stage, message: runtime.message })
    void this.initialize(runtime, runtime.generation)
    return this.runtimeState(runtime)
  }

  private advanceInitialization(runtime: OwnedRuntime, stage: PiLiveInitializationStage, now = Date.now()): void {
    if (runtime.stage !== stage) {
      if (runtime.stage !== 'ready') {
        runtime.initializationTimings.push({ stage: runtime.stage, durationMs: Math.max(0, now - runtime.stageStartedAt) })
      }
      runtime.stage = stage
      runtime.stageStartedAt = now
    }
    runtime.initializationElapsedMs = Math.max(0, now - runtime.initializationStartedAt)
  }

  private async initialize(runtime: OwnedRuntime, generation: number): Promise<void> {
    try {
      const handle = await this.host.start(runtime.id, runtime.input, runtime.initialization.signal, event => {
        if (runtime.generation !== generation || runtime.status === 'terminating' || runtime.status === 'terminated') return
        if (event.type === 'runtime_initialization') {
          const stage = event.stage
          if (typeof stage === 'string' && ['starting_worker', 'loading_sdk', 'loading_resources', 'creating_session', 'binding_extensions', 'ready'].includes(stage)) {
            this.advanceInitialization(runtime, stage as PiLiveInitializationStage)
          }
          if (typeof event.message === 'string') runtime.message = event.message.slice(0, 500)
        } else if (event.type === 'runtime_resources') {
          runtime.startupResources = startupResources(event.resources) ?? runtime.startupResources
        } else if (event.type === 'runtime_output') {
          if (typeof event.message === 'string' && event.message.trim()) {
            runtime.startupOutput = [...runtime.startupOutput, event.message.trim()].slice(-80)
          }
        } else if (event.type === 'runtime_capabilities') {
          runtime.capabilities = runtimeCapabilities(event.capabilities) ?? runtime.capabilities
        }
        this.publish(runtime, event)
      }, error => this.workerExited(runtime, generation, error))
      if (runtime.generation !== generation || runtime.status !== 'initializing') { await handle.terminate(); return }
      runtime.handle = handle
      runtime.capabilities = handle.capabilities ?? runtime.capabilities
      if (!runtime.initializationTimings.length && handle.initializationTimings?.length) runtime.initializationTimings = [...handle.initializationTimings]
      this.advanceInitialization(runtime, 'ready')
      runtime.status = 'ready'
      runtime.message = `Pi Runtime 已就绪 · ${formatElapsed(runtime.initializationElapsedMs)}`
      this.publish(runtime, {
        type: 'runtime_status',
        status: 'ready',
        stage: 'ready',
        message: runtime.message,
        initializationElapsedMs: runtime.initializationElapsedMs,
        initializationTimings: runtime.initializationTimings,
        ...(runtime.capabilities ? { capabilities: runtime.capabilities } : {}),
      })
    } catch (error) {
      if (runtime.generation !== generation || runtime.status === 'terminating' || runtime.status === 'terminated') return
      runtime.initializationElapsedMs = Math.max(0, Date.now() - runtime.initializationStartedAt)
      runtime.status = 'failed'
      runtime.error = safeError(error)
      runtime.message = `Pi Runtime 初始化失败 · ${formatElapsed(runtime.initializationElapsedMs)}`
      this.publish(runtime, { type: 'runtime_status', status: 'failed', stage: runtime.stage, message: runtime.message, error: runtime.error, initializationElapsedMs: runtime.initializationElapsedMs, initializationTimings: runtime.initializationTimings })
    }
  }

  private workerExited(runtime: OwnedRuntime, generation: number, error: Error): void {
    if (runtime.generation !== generation || runtime.status === 'terminating' || runtime.status === 'terminated') return
    runtime.handle = undefined
    runtime.initializationElapsedMs = Math.max(runtime.initializationElapsedMs, Date.now() - runtime.initializationStartedAt)
    runtime.status = 'failed'
    runtime.error = safeError(error)
    runtime.message = 'Pi Runtime Worker 已退出'
    this.publish(runtime, { type: 'runtime_status', status: 'failed', stage: runtime.stage, message: runtime.message, error: runtime.error, initializationElapsedMs: runtime.initializationElapsedMs, initializationTimings: runtime.initializationTimings })
  }

  async state(id: string): Promise<PiLiveRuntimeState> { return this.runtimeState(this.requireRuntime(id)) }
  async snapshot(id: string, since?: string): Promise<PiLiveSnapshot> { const runtime = this.requireRuntime(id); if (!runtime.handle || runtime.status !== 'ready') return { state: await this.runtimeState(runtime), entries: [], leafId: null }; const snapshot = await runtime.handle.snapshot(since); return { ...snapshot, state: this.decorateReadyState(runtime, snapshot.state) } }
  async controls(id: string): Promise<PiLiveControls> { return this.requireReady(id).handle!.controls() }
  async setModel(id: string, provider: string, modelId: string): Promise<PiLiveRuntimeState> { const runtime = this.requireReady(id); return this.decorateReadyState(runtime, await runtime.handle!.setModel(provider, modelId)) }
  async setThinkingLevel(id: string, level: string): Promise<PiLiveRuntimeState> { const runtime = this.requireReady(id); return this.decorateReadyState(runtime, await runtime.handle!.setThinkingLevel(level)) }
  async prompt(id: string, message: string, behavior?: PiLiveStreamingBehavior): Promise<void> { if (message.trim()) await this.requireReady(id).handle!.prompt(message, behavior) }
  async steer(id: string, message: string): Promise<void> { if (message.trim()) await this.requireReady(id).handle!.steer(message) }
  async followUp(id: string, message: string): Promise<void> { if (message.trim()) await this.requireReady(id).handle!.followUp(message) }
  async clearQueue(id: string): Promise<PiLiveQueueState> { return this.requireReady(id).handle!.clearQueue() }
  async abort(id: string, options: { restoreQueue?: boolean } = {}): Promise<PiLiveQueueState> { return this.requireReady(id).handle!.abort(options.restoreQueue !== false) }
  async respondToExtension(id: string, requestId: string, response: unknown): Promise<void> { if (!requestId) throw new Error('Pi extension request id is required'); await this.requireReady(id).handle!.respondToExtension(requestId, response) }
  subscribe(id: string, listener: PiLiveRuntimeListener): () => void { const runtime = this.requireRuntime(id); runtime.listeners.add(listener); return () => runtime.listeners.delete(listener) }

  async terminate(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    runtime.generation += 1
    runtime.initialization.abort()
    runtime.status = 'terminating'
    runtime.message = '正在结束 Pi Runtime'
    this.publish(runtime, { type: 'runtime_status', status: 'terminating', stage: runtime.stage, message: runtime.message })
    const handle = runtime.handle
    runtime.handle = undefined
    if (handle) await handle.terminate().catch(() => undefined)
    runtime.status = 'terminated'
    runtime.message = 'Pi Runtime 已结束'
    this.publish(runtime, { type: 'runtime_status', status: 'terminated', stage: runtime.stage, message: runtime.message })
    runtime.listeners.clear()
    this.runtimes.delete(id)
  }

  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; await Promise.allSettled([...this.runtimes.keys()].map(id => this.terminate(id))) }

  private conflict(message: string): Error { const error = new Error(message) as Error & { statusCode?: number }; error.statusCode = 409; return error }
  private requireRuntime(id: string): OwnedRuntime { const runtime = this.runtimes.get(id); if (!runtime) throw new Error(`Unknown Pi Live runtime session: ${id}`); return runtime }
  private requireReady(id: string): OwnedRuntime { const runtime = this.requireRuntime(id); if (runtime.status !== 'ready' || !runtime.handle) throw this.conflict(`Pi Live runtime is not ready: ${runtime.status}`); return runtime }
  private async runtimeState(runtime: OwnedRuntime): Promise<PiLiveRuntimeState> {
    if (runtime.status === 'initializing') runtime.initializationElapsedMs = Math.max(0, Date.now() - runtime.initializationStartedAt)
    if (runtime.status === 'ready' && runtime.handle) return this.decorateReadyState(runtime, await runtime.handle.state())
    return {
      runtimeSessionId: runtime.id,
      status: runtime.status,
      initializationStage: runtime.stage,
      initializationMessage: runtime.message,
      initializationElapsedMs: runtime.initializationElapsedMs,
      initializationTimings: runtime.initializationTimings,
      ...(runtime.startupResources ? { startupResources: runtime.startupResources } : {}),
      ...(runtime.startupOutput.length ? { startupOutput: runtime.startupOutput } : {}),
      ...(runtime.capabilities ? { capabilities: runtime.capabilities } : {}),
      ...(runtime.error ? { error: runtime.error } : {}),
      ...(runtime.input.name ? { sessionName: runtime.input.name } : {}),
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      ...(runtime.handle?.processId ? { processId: runtime.handle.processId } : {}),
    }
  }
  private decorateReadyState(runtime: OwnedRuntime, state: PiLiveRuntimeState): PiLiveRuntimeState {
    return {
      ...state,
      runtimeSessionId: runtime.id,
      status: 'ready',
      initializationStage: 'ready',
      initializationMessage: runtime.message,
      initializationElapsedMs: runtime.initializationElapsedMs,
      initializationTimings: runtime.initializationTimings,
      ...(runtime.startupResources ? { startupResources: runtime.startupResources } : {}),
      ...(runtime.startupOutput.length ? { startupOutput: runtime.startupOutput } : {}),
      ...(runtime.capabilities ? { capabilities: runtime.capabilities } : {}),
      ...(runtime.handle?.processId ? { processId: runtime.handle.processId } : {}),
    }
  }
  private publish(runtime: OwnedRuntime, event: Record<string, unknown>): void { runtime.sequence += 1; const value: PiLiveRuntimeEvent = { runtimeSessionId: runtime.id, sequence: runtime.sequence, receivedAt: new Date().toISOString(), event }; for (const listener of runtime.listeners) listener(value) }
}
