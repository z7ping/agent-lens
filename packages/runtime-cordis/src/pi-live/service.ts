import { randomUUID } from 'node:crypto'
import { findPiExecutable, type PiSdkLoader } from './sdk-loader'
import { InProcessPiRuntimeHost } from './in-process-host'
import { WorkerPiRuntimeHost, type PiRuntimeHandle, type PiRuntimeHost } from './worker-host'
import type { PiLiveAvailability, PiLiveControls, PiLiveInitializationStage, PiLiveQueueState, PiLiveRuntimeEvent, PiLiveRuntimeListener, PiLiveRuntimeState, PiLiveService, PiLiveSnapshot, PiLiveStartInput, PiLiveStreamingBehavior } from './types'

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
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:api[_-]?key|token|authorization|password)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 2_000)
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
    const runtime: OwnedRuntime = { id, input, status: 'initializing', stage: 'starting_worker', message: '正在启动独立 Pi Runtime Worker', listeners: new Set(), sequence: 0, generation: 1, initialization: new AbortController() }
    this.runtimes.set(id, runtime)
    void this.initialize(runtime, runtime.generation)
    return this.runtimeState(runtime)
  }

  async retry(runtimeSessionId: string): Promise<PiLiveRuntimeState> {
    const runtime = this.requireRuntime(runtimeSessionId)
    if (runtime.status !== 'failed') throw this.conflict('Pi Live runtime can only retry after initialization failed')
    runtime.generation += 1
    runtime.initialization = new AbortController()
    runtime.status = 'initializing'
    runtime.stage = 'starting_worker'
    runtime.message = '正在重新启动独立 Pi Runtime Worker'
    runtime.error = undefined
    this.publish(runtime, { type: 'runtime_status', status: runtime.status, stage: runtime.stage, message: runtime.message })
    void this.initialize(runtime, runtime.generation)
    return this.runtimeState(runtime)
  }

  private async initialize(runtime: OwnedRuntime, generation: number): Promise<void> {
    try {
      const handle = await this.host.start(runtime.id, runtime.input, runtime.initialization.signal, event => {
        if (runtime.generation !== generation || runtime.status === 'terminating' || runtime.status === 'terminated') return
        if (event.type === 'runtime_initialization') {
          const stage = event.stage
          if (typeof stage === 'string' && ['starting_worker', 'loading_sdk', 'loading_resources', 'creating_session', 'binding_extensions', 'ready'].includes(stage)) runtime.stage = stage as PiLiveInitializationStage
          if (typeof event.message === 'string') runtime.message = event.message.slice(0, 500)
        }
        this.publish(runtime, event)
      }, error => this.workerExited(runtime, generation, error))
      if (runtime.generation !== generation || runtime.status !== 'initializing') { await handle.terminate(); return }
      runtime.handle = handle
      runtime.status = 'ready'
      runtime.stage = 'ready'
      runtime.message = 'Pi Runtime 已就绪'
      this.publish(runtime, { type: 'runtime_status', status: 'ready', stage: 'ready', message: runtime.message })
    } catch (error) {
      if (runtime.generation !== generation || runtime.status === 'terminating' || runtime.status === 'terminated') return
      runtime.status = 'failed'
      runtime.error = safeError(error)
      runtime.message = 'Pi Runtime 初始化失败'
      this.publish(runtime, { type: 'runtime_status', status: 'failed', stage: runtime.stage, message: runtime.message, error: runtime.error })
    }
  }

  private workerExited(runtime: OwnedRuntime, generation: number, error: Error): void {
    if (runtime.generation !== generation || runtime.status === 'terminating' || runtime.status === 'terminated') return
    runtime.handle = undefined
    runtime.status = 'failed'
    runtime.error = safeError(error)
    runtime.message = 'Pi Runtime Worker 已退出'
    this.publish(runtime, { type: 'runtime_status', status: 'failed', stage: runtime.stage, message: runtime.message, error: runtime.error })
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
  private async runtimeState(runtime: OwnedRuntime): Promise<PiLiveRuntimeState> { if (runtime.status === 'ready' && runtime.handle) return this.decorateReadyState(runtime, await runtime.handle.state()); return { runtimeSessionId: runtime.id, status: runtime.status, initializationStage: runtime.stage, initializationMessage: runtime.message, ...(runtime.error ? { error: runtime.error } : {}), ...(runtime.input.name ? { sessionName: runtime.input.name } : {}), isStreaming: false, isCompacting: false, pendingMessageCount: 0, ...(runtime.handle?.processId ? { processId: runtime.handle.processId } : {}) } }
  private decorateReadyState(runtime: OwnedRuntime, state: PiLiveRuntimeState): PiLiveRuntimeState { return { ...state, runtimeSessionId: runtime.id, status: 'ready', initializationStage: 'ready', initializationMessage: runtime.message, ...(runtime.handle?.processId ? { processId: runtime.handle.processId } : {}) } }
  private publish(runtime: OwnedRuntime, event: Record<string, unknown>): void { runtime.sequence += 1; const value: PiLiveRuntimeEvent = { runtimeSessionId: runtime.id, sequence: runtime.sequence, receivedAt: new Date().toISOString(), event }; for (const listener of runtime.listeners) listener(value) }
}
