import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { findPiExecutable, type PiSdkLoader } from './sdk-loader'
import { InProcessPiRuntimeHost } from './in-process-host'
import type { PiLiveRecoveryRecord, PiLiveRecoveryStore } from './recovery-store'
import { WorkerPiRuntimeHost, type PiRuntimeHandle, type PiRuntimeHost } from './worker-host'
import type { PiLiveAvailability, PiLiveControls, PiLiveInitializationStage, PiLiveInitializationTiming, PiLiveQueueState, PiLiveRuntimeCapabilities, PiLiveRuntimeEvent, PiLiveRuntimeListener, PiLiveRuntimeState, PiLiveService, PiLiveSnapshot, PiLiveStartInput, PiLiveStartupResources, PiLiveStreamingBehavior } from './types'

interface OwnedRuntime {
  id: string
  input: PiLiveStartInput
  createdAt: string
  restored: boolean
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
  workspacePath: string
  projectName: string
  gitBranch?: string | undefined
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

function sessionPathKey(value: string): string {
  const path = resolve(value)
  return process.platform === 'win32' ? path.toLowerCase() : path
}

interface ResolvedWorkspaceContext {
  workspacePath: string
  projectName: string
  gitBranch?: string | undefined
}

async function resolveGitContext(workspacePath: string): Promise<{ root: string; branch?: string | undefined } | undefined> {
  let current = workspacePath
  while (true) {
    const marker = join(current, '.git')
    try {
      const markerStat = await stat(marker)
      let gitDir = marker
      if (markerStat.isFile()) {
        const pointer = await readFile(marker, 'utf8')
        const match = pointer.match(/^gitdir:\s*(.+)$/im)
        if (!match?.[1]) return { root: current }
        gitDir = resolve(current, match[1].trim())
      } else if (!markerStat.isDirectory()) {
        return { root: current }
      }
      const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
      const branchPrefix = 'ref: refs/heads/'
      if (head.startsWith(branchPrefix)) return { root: current, branch: head.slice(branchPrefix.length) }
      if (/^[0-9a-f]{7,40}$/i.test(head)) return { root: current, branch: head.slice(0, 8) }
      return { root: current }
    } catch {
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

async function resolveWorkspaceContext(cwd: string): Promise<ResolvedWorkspaceContext> {
  const workspacePath = resolve(cwd)
  const git = await resolveGitContext(workspacePath).catch(() => undefined)
  const projectRoot = git?.root ?? workspacePath
  return {
    workspacePath,
    projectName: basename(projectRoot) || projectRoot,
    ...(git?.branch ? { gitBranch: git.branch } : {}),
  }
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

function recoveryInput(input: PiLiveStartInput, resumedSessionPath?: string): PiLiveStartInput {
  const resumedPath = resumedSessionPath?.trim()
  if (resumedPath) {
    return {
      cwd: input.cwd,
      ...(input.name ? { name: input.name } : {}),
      sessionPath: resumedPath,
      historyAction: 'continue',
    }
  }
  const existingPath = input.sessionPath?.trim()
  if (existingPath) {
    return {
      cwd: input.cwd,
      ...(input.name ? { name: input.name } : {}),
      sessionPath: existingPath,
      historyAction: input.historyAction === 'fork' ? 'fork' : 'continue',
    }
  }
  return {
    cwd: input.cwd,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.name ? { name: input.name } : {}),
    ...(input.sessionDir ? { sessionDir: input.sessionDir } : {}),
    ...(input.historyAction ? { historyAction: input.historyAction } : {}),
  }
}

export class DefaultPiLiveService implements PiLiveService {
  private readonly runtimes = new Map<string, OwnedRuntime>()
  private readonly host: PiRuntimeHost
  private readonly recoveryStore?: PiLiveRecoveryStore | undefined
  private availabilityPromise: Promise<PiLiveAvailability> | null = null
  private recoveryLoadPromise: Promise<void> | null = null
  private recoveryLoaded = false
  private disposed = false

  constructor(dependency?: PiSdkLoader | PiRuntimeHost, recoveryStore?: PiLiveRecoveryStore) {
    this.host = typeof dependency === 'function' ? new InProcessPiRuntimeHost(dependency) : dependency ?? new WorkerPiRuntimeHost()
    this.recoveryStore = recoveryStore
  }

  async availability(): Promise<PiLiveAvailability> {
    if (!this.availabilityPromise) {
      this.availabilityPromise = findPiExecutable().then(executable => executable
        ? { available: true, executable }
        : { available: false, reason: 'Pi executable was not found in PATH or PI_BIN' })
    }
    return this.availabilityPromise
  }

  /** Worker 自己加载 SDK；同时恢复上一个 Daemon generation 尚未被用户结束的 Live Task。 */
  async preload(): Promise<void> {
    await Promise.all([this.availability(), this.ensureRecoveryLoaded()])
  }

  async list(): Promise<PiLiveRuntimeState[]> {
    await this.ensureRecoveryLoaded()
    return Promise.all([...this.runtimes.values()].map(runtime => this.runtimeState(runtime)))
  }

  async start(input: PiLiveStartInput): Promise<PiLiveRuntimeState> {
    if (this.disposed) throw new Error('Pi Live service is disposed')
    if (!input.cwd.trim()) throw new Error('Pi Live requires a working directory')
    await this.ensureRecoveryLoaded()
    if (input.sessionPath) {
      const requestedPath = sessionPathKey(input.sessionPath)
      const duplicate = [...this.runtimes.values()].find(runtime => runtime.input.sessionPath
        && sessionPathKey(runtime.input.sessionPath) === requestedPath
        && runtime.status !== 'terminated')
      if (duplicate) throw this.conflict('该 Pi 历史会话已经在进行中，请直接打开现有实时任务')
    }
    const runtime = this.createRuntime(randomUUID(), input, false)
    this.runtimes.set(runtime.id, runtime)
    try {
      await this.persistRuntime(runtime)
    } catch (error) {
      this.runtimes.delete(runtime.id)
      throw error
    }
    const initialState = await this.runtimeState(runtime)
    this.scheduleInitialize(runtime, runtime.generation)
    return initialState
  }

  async retry(runtimeSessionId: string): Promise<PiLiveRuntimeState> {
    const runtime = await this.runtime(runtimeSessionId)
    if (runtime.status !== 'failed') throw this.conflict('Pi Live runtime can only retry after initialization failed')
    const now = Date.now()
    runtime.generation += 1
    runtime.initialization = new AbortController()
    runtime.status = 'initializing'
    runtime.stage = 'starting_worker'
    runtime.message = runtime.restored ? '正在重新恢复 Pi Runtime' : '正在重新启动独立 Pi Runtime Worker'
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
    const initialState = await this.runtimeState(runtime)
    this.scheduleInitialize(runtime, runtime.generation)
    return initialState
  }

  private scheduleInitialize(runtime: OwnedRuntime, generation: number): void {
    queueMicrotask(() => { void this.initialize(runtime, generation) })
  }

  private createRuntime(id: string, input: PiLiveStartInput, restored: boolean, createdAt = new Date().toISOString()): OwnedRuntime {
    const now = Date.now()
    const normalizedInput = restored ? recoveryInput(input) : input
    const workspacePath = resolve(normalizedInput.cwd)
    return {
      id,
      input: normalizedInput,
      createdAt,
      restored,
      status: 'initializing',
      stage: 'starting_worker',
      message: restored ? '正在恢复 Pi Runtime' : '正在启动独立 Pi Runtime Worker',
      listeners: new Set(),
      sequence: 0,
      generation: 1,
      initialization: new AbortController(),
      initializationStartedAt: now,
      stageStartedAt: now,
      initializationElapsedMs: 0,
      initializationTimings: [],
      startupOutput: [],
      workspacePath,
      projectName: basename(workspacePath) || workspacePath,
    }
  }

  private async ensureRecoveryLoaded(): Promise<void> {
    if (!this.recoveryStore || this.recoveryLoaded || this.disposed) return
    if (!this.recoveryLoadPromise) {
      this.recoveryLoadPromise = this.restorePersistedRuntimes()
        .then(() => { this.recoveryLoaded = true })
        .finally(() => { this.recoveryLoadPromise = null })
    }
    await this.recoveryLoadPromise
  }

  private async restorePersistedRuntimes(): Promise<void> {
    if (!this.recoveryStore || this.disposed) return
    const records = await this.recoveryStore.list()
    for (const item of records) {
      if (this.disposed) return
      if (this.runtimes.has(item.id)) continue
      const runtime = this.createRuntime(item.id, item.input, true, item.createdAt)
      this.runtimes.set(runtime.id, runtime)
      void this.initialize(runtime, runtime.generation)
    }
  }

  private async persistRuntime(runtime: OwnedRuntime, state?: PiLiveRuntimeState): Promise<void> {
    if (!this.recoveryStore) return
    const nextInput = recoveryInput(runtime.input, state?.sessionFile)
    const value: PiLiveRecoveryRecord = {
      id: runtime.id,
      input: nextInput,
      createdAt: runtime.createdAt,
      updatedAt: new Date().toISOString(),
    }
    await this.recoveryStore.put(value)
    if (state?.sessionFile) runtime.input = nextInput
  }

  private persistRuntimeBestEffort(runtime: OwnedRuntime, state?: PiLiveRuntimeState): void {
    void this.persistRuntime(runtime, state).catch(error => {
      const message = `Pi Live recovery checkpoint failed: ${safeError(error)}`
      if (!runtime.startupOutput.includes(message)) runtime.startupOutput = [...runtime.startupOutput, message].slice(-80)
      console.warn(`[AgentLens] ${message}`)
    })
  }

  private persistSessionIfChanged(runtime: OwnedRuntime, state: PiLiveRuntimeState): void {
    const nextPath = state.sessionFile?.trim()
    if (!nextPath) return
    const currentPath = runtime.input.sessionPath?.trim()
    if (currentPath && sessionPathKey(currentPath) === sessionPathKey(nextPath) && runtime.input.historyAction === 'continue') return
    this.persistRuntimeBestEffort(runtime, state)
  }

  private async refreshWorkspaceContext(runtime: OwnedRuntime): Promise<void> {
    const context = await resolveWorkspaceContext(runtime.input.cwd)
    runtime.workspacePath = context.workspacePath
    runtime.projectName = context.projectName
    runtime.gitBranch = context.gitBranch
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

      const requiresResolvedSessionCheckpoint = Boolean(
        this.recoveryStore && (!runtime.input.sessionPath?.trim() || runtime.input.historyAction === 'fork'),
      )
      let readyState: PiLiveRuntimeState | undefined
      if (runtime.input.historyAction === 'fork' && runtime.input.sessionPath) {
        const forkedState = await handle.state()
        if (!forkedState.sessionFile || sessionPathKey(forkedState.sessionFile) === sessionPathKey(runtime.input.sessionPath)) {
          await handle.terminate().catch(() => undefined)
          runtime.handle = undefined
          throw new Error('Pi 分叉 Runtime 未切换到新的 Session，已拒绝继续')
        }
        runtime.input = { ...runtime.input, sessionPath: forkedState.sessionFile, historyAction: 'continue' }
        readyState = forkedState
      }
      if (!readyState) readyState = await handle.state().catch(() => undefined)
      if (requiresResolvedSessionCheckpoint && !readyState?.sessionFile?.trim()) {
        await handle.terminate().catch(() => undefined)
        runtime.handle = undefined
        throw new Error('Pi Runtime 已启动，但没有可用于 Daemon 恢复的原生 Session')
      }
      if (readyState) {
        try {
          await this.persistRuntime(runtime, readyState)
        } catch (error) {
          await handle.terminate().catch(() => undefined)
          runtime.handle = undefined
          throw new Error(`Pi Live recovery checkpoint failed: ${safeError(error)}`)
        }
      }

      this.advanceInitialization(runtime, 'ready')
      runtime.status = 'ready'
      runtime.message = runtime.restored
        ? `Pi Runtime 已恢复 · ${formatElapsed(runtime.initializationElapsedMs)}`
        : `Pi Runtime 已就绪 · ${formatElapsed(runtime.initializationElapsedMs)}`
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
      runtime.message = runtime.restored
        ? `Pi Runtime 恢复失败 · ${formatElapsed(runtime.initializationElapsedMs)}`
        : `Pi Runtime 初始化失败 · ${formatElapsed(runtime.initializationElapsedMs)}`
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

  async state(id: string): Promise<PiLiveRuntimeState> {
    return this.runtimeState(await this.runtime(id))
  }

  async snapshot(id: string, since?: string): Promise<PiLiveSnapshot> {
    const runtime = await this.runtime(id)
    if (!runtime.handle || runtime.status !== 'ready') return { state: await this.runtimeState(runtime), entries: [], leafId: null }
    const snapshot = await runtime.handle.snapshot(since)
    this.persistSessionIfChanged(runtime, snapshot.state)
    return { ...snapshot, state: this.decorateReadyState(runtime, snapshot.state) }
  }

  async controls(id: string): Promise<PiLiveControls> { return (await this.readyRuntime(id)).handle!.controls() }
  async setModel(id: string, provider: string, modelId: string): Promise<PiLiveRuntimeState> { const runtime = await this.readyRuntime(id); return this.decorateReadyState(runtime, await runtime.handle!.setModel(provider, modelId)) }
  async setThinkingLevel(id: string, level: string): Promise<PiLiveRuntimeState> { const runtime = await this.readyRuntime(id); return this.decorateReadyState(runtime, await runtime.handle!.setThinkingLevel(level)) }
  async prompt(id: string, message: string, behavior?: PiLiveStreamingBehavior): Promise<void> { if (message.trim()) await (await this.readyRuntime(id)).handle!.prompt(message, behavior) }
  async steer(id: string, message: string): Promise<void> { if (message.trim()) await (await this.readyRuntime(id)).handle!.steer(message) }
  async followUp(id: string, message: string): Promise<void> { if (message.trim()) await (await this.readyRuntime(id)).handle!.followUp(message) }
  async clearQueue(id: string): Promise<PiLiveQueueState> { return (await this.readyRuntime(id)).handle!.clearQueue() }
  async abort(id: string, options: { restoreQueue?: boolean } = {}): Promise<PiLiveQueueState> { return (await this.readyRuntime(id)).handle!.abort(options.restoreQueue !== false) }
  async respondToExtension(id: string, requestId: string, response: unknown): Promise<void> { if (!requestId) throw new Error('Pi extension request id is required'); await (await this.readyRuntime(id)).handle!.respondToExtension(requestId, response) }

  /** HTTP events calls state() before subscribe(), so lazy recovery is complete before this synchronous registration. */
  subscribe(id: string, listener: PiLiveRuntimeListener): () => void {
    const runtime = this.requireRuntime(id)
    runtime.listeners.add(listener)
    return () => runtime.listeners.delete(listener)
  }

  async terminate(id: string): Promise<void> {
    await this.ensureRecoveryLoaded()
    await this.recoveryStore?.remove(id)
    const runtime = this.runtimes.get(id)
    if (runtime) await this.terminateRuntime(runtime, true)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.recoveryLoadPromise) await this.recoveryLoadPromise.catch(() => undefined)
    const runtimes = [...this.runtimes.values()]
    await Promise.allSettled(runtimes.map(async runtime => {
      if (runtime.status === 'ready' && runtime.handle) {
        const state = await runtime.handle.state().catch(() => undefined)
        if (state) await this.persistRuntime(runtime, state).catch(() => undefined)
      }
      await this.terminateRuntime(runtime, false)
    }))
  }

  private async terminateRuntime(runtime: OwnedRuntime, explicit: boolean): Promise<void> {
    runtime.generation += 1
    runtime.initialization.abort()
    if (explicit) {
      runtime.status = 'terminating'
      runtime.message = '正在结束 Pi Runtime'
      this.publish(runtime, { type: 'runtime_status', status: 'terminating', stage: runtime.stage, message: runtime.message })
    }
    const handle = runtime.handle
    runtime.handle = undefined
    if (handle) await handle.terminate().catch(() => undefined)
    if (explicit) {
      runtime.status = 'terminated'
      runtime.message = 'Pi Runtime 已结束'
      this.publish(runtime, { type: 'runtime_status', status: 'terminated', stage: runtime.stage, message: runtime.message })
    }
    runtime.listeners.clear()
    this.runtimes.delete(runtime.id)
  }

  private conflict(message: string): Error { const error = new Error(message) as Error & { statusCode?: number }; error.statusCode = 409; return error }

  private async runtime(id: string): Promise<OwnedRuntime> {
    await this.ensureRecoveryLoaded()
    return this.requireRuntime(id)
  }

  private async readyRuntime(id: string): Promise<OwnedRuntime> {
    const runtime = await this.runtime(id)
    if (runtime.status !== 'ready' || !runtime.handle) throw this.conflict(`Pi Live runtime is not ready: ${runtime.status}`)
    return runtime
  }

  private requireRuntime(id: string): OwnedRuntime {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error(`Unknown Pi Live runtime session: ${id}`)
    return runtime
  }

  private async runtimeState(runtime: OwnedRuntime): Promise<PiLiveRuntimeState> {
    await this.refreshWorkspaceContext(runtime)
    if (runtime.status === 'initializing') runtime.initializationElapsedMs = Math.max(0, Date.now() - runtime.initializationStartedAt)
    if (runtime.status === 'ready' && runtime.handle) {
      const state = await runtime.handle.state()
      this.persistSessionIfChanged(runtime, state)
      return this.decorateReadyState(runtime, state)
    }
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
      workspacePath: runtime.workspacePath,
      projectName: runtime.projectName,
      ...(runtime.gitBranch ? { gitBranch: runtime.gitBranch } : {}),
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
      workspacePath: runtime.workspacePath,
      projectName: runtime.projectName,
      ...(runtime.gitBranch ? { gitBranch: runtime.gitBranch } : {}),
      ...(runtime.handle?.processId ? { processId: runtime.handle.processId } : {}),
    }
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
}
