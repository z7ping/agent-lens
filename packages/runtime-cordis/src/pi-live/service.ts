import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { formatLiveError, LiveEventChannel } from '@agent-lens/live-support'
import { findPiExecutable, type PiSdkLoader } from './sdk-loader'
import { InProcessPiRuntimeHost } from './in-process-host'
import type { PiLiveRecoveryRecord, PiLiveRecoveryStore } from './recovery-store'
import type { PiLiveStartupAuditSink } from './startup-audit'
import { WorkerPiRuntimeHost, type PiRuntimeHandle, type PiRuntimeHost } from './worker-host'
import type { PiLiveAvailability, PiLiveControls, PiLiveInitializationStage, PiLiveInitializationTiming, PiLivePackageUpdate, PiLivePackageUpdateCheckStatus, PiLiveQueueState, PiLiveRuntimeCapabilities, PiLiveRuntimeListener, PiLiveRuntimeState, PiLiveService, PiLiveSnapshot, PiLiveStartInput, PiLiveStartupResources, PiLiveStreamingBehavior } from './types'

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
  events: LiveEventChannel
  generation: number
  initialization: AbortController
  initializationStartedAt: number
  stageStartedAt: number
  initializationElapsedMs: number
  initializationTimings: PiLiveInitializationTiming[]
  startupResources?: PiLiveStartupResources | undefined
  startupAuditResources?: PiLiveStartupResources | undefined
  startupOutput: string[]
  packageUpdates: PiLivePackageUpdate[]
  packageUpdateCheck: PiLivePackageUpdateCheckStatus
  capabilities?: PiLiveRuntimeCapabilities | undefined
  workspacePath: string
  projectName: string
  gitBranch?: string | undefined
  taskSummary?: string | undefined
  recoverySessionPath?: string | undefined
  recoveryCheckpointPending?: string | undefined
  recoveryCheckpointTask?: Promise<void> | undefined
  startupResourcesCapturedAt?: string | undefined
  startupAuditCompleted?: string | undefined
  startupAuditPending?: string | undefined
  startupAuditTask?: Promise<void> | undefined
  startupAuditProbeTask?: Promise<void> | undefined
}

function taskSummary(message: string): string | undefined {
  const normalized = message.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, 240) : undefined
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

function packageUpdates(value: unknown): PiLivePackageUpdate[] {
  if (!Array.isArray(value)) return []
  const updates: PiLivePackageUpdate[] = []
  for (const item of value) {
    const row = record(item)
    if (typeof row.source !== 'string' || typeof row.displayName !== 'string') continue
    if (row.type !== 'npm' && row.type !== 'git') continue
    if (row.scope !== 'user' && row.scope !== 'project') continue
    updates.push({
      source: row.source.slice(0, 500),
      displayName: row.displayName.slice(0, 240),
      type: row.type,
      scope: row.scope,
    })
  }
  return updates.slice(0, 240)
}

function packageUpdateStatus(value: unknown): PiLivePackageUpdateCheckStatus | undefined {
  return value === 'checking' || value === 'complete' || value === 'unavailable' || value === 'failed'
    ? value
    : undefined
}

function copyStartupResources(resources: PiLiveStartupResources): PiLiveStartupResources {
  return {
    contexts: [...resources.contexts],
    skills: [...resources.skills],
    prompts: [...resources.prompts],
    extensions: [...resources.extensions],
    themes: [...resources.themes],
    diagnostics: [...resources.diagnostics],
  }
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
  const existingPath = resumedPath || input.sessionPath?.trim()
  if (existingPath) {
    return {
      cwd: input.cwd,
      ...(input.name ? { name: input.name } : {}),
      sessionPath: existingPath,
      historyAction: 'continue',
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

  constructor(
    dependency?: PiSdkLoader | PiRuntimeHost,
    recoveryStore?: PiLiveRecoveryStore,
    private readonly startupAudit?: PiLiveStartupAuditSink,
  ) {
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

  /**
   * SDK 只在空闲 Worker 内预热；失败时保留冷启动路径。Recovery 不依赖预热成功。
   */
  async preload(): Promise<void> {
    await Promise.all([
      this.availability(),
      this.ensureRecoveryLoaded(),
      this.host.preload?.().catch(error => {
        console.warn('[AgentLens] Pi Live SDK Worker 预热失败；新建任务将按冷启动路径继续', error)
      }),
    ])
  }

  async list(): Promise<PiLiveRuntimeState[]> {
    await this.ensureRecoveryLoaded()
    return Promise.all([...this.runtimes.values()].map(runtime => this.runtimeState(runtime)))
  }

  async start(input: PiLiveStartInput): Promise<PiLiveRuntimeState> {
    if (this.disposed) throw new Error('Pi Live service is disposed')
    if (!input.cwd.trim()) throw new Error('Pi Live requires a working directory')
    await this.ensureRecoveryLoaded()
    if (input.sessionPath && input.historyAction !== 'fork') {
      const requestedPath = sessionPathKey(input.sessionPath)
      const duplicate = [...this.runtimes.values()].find(runtime => runtime.input.sessionPath
        && sessionPathKey(runtime.input.sessionPath) === requestedPath
        && runtime.status !== 'terminated')
      // “继续”同一份历史不是创建第二个 Runtime，而是回到已经存在的那个。
      // 这让重复点击和前端跳转中断都保持幂等；“分叉”仍需保留新 Runtime。
      if (duplicate) return this.runtimeState(duplicate)
    }
    const runtime = this.createRuntime(randomUUID(), input, false)
    this.runtimes.set(runtime.id, runtime)
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
    runtime.startupAuditResources = undefined
    runtime.startupResourcesCapturedAt = undefined
    runtime.startupAuditCompleted = undefined
    runtime.startupAuditPending = undefined
    runtime.startupAuditTask = undefined
    runtime.startupAuditProbeTask = undefined
    runtime.startupOutput = []
    runtime.packageUpdates = []
    runtime.packageUpdateCheck = 'checking'
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
      events: new LiveEventChannel(id),
      generation: 1,
      initialization: new AbortController(),
      initializationStartedAt: now,
      stageStartedAt: now,
      initializationElapsedMs: 0,
      initializationTimings: [],
      startupOutput: [],
      packageUpdates: [],
      packageUpdateCheck: 'checking',
      workspacePath,
      projectName: basename(workspacePath) || workspacePath,
      ...(restored && normalizedInput.sessionPath ? { recoverySessionPath: normalizedInput.sessionPath } : {}),
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

  private adoptRuntimeSession(runtime: OwnedRuntime, sessionPath: string): void {
    const nextPath = sessionPath.trim()
    if (!nextPath) return
    const currentPath = runtime.input.sessionPath?.trim()
    if (currentPath && sessionPathKey(currentPath) === sessionPathKey(nextPath) && runtime.input.historyAction === 'continue') return
    runtime.input = recoveryInput(runtime.input, nextPath)
  }

  private async persistRuntime(runtime: OwnedRuntime): Promise<void> {
    if (!this.recoveryStore) return
    const sessionPath = runtime.input.sessionPath?.trim()
    if (!sessionPath) return
    const value: PiLiveRecoveryRecord = {
      id: runtime.id,
      input: recoveryInput(runtime.input, sessionPath),
      createdAt: runtime.createdAt,
      updatedAt: new Date().toISOString(),
    }
    await this.recoveryStore.put(value)
    runtime.recoverySessionPath = sessionPath
  }

  private recoveryDiagnostic(runtime: OwnedRuntime, prefix: string, error: unknown): void {
    const message = `${prefix}: ${formatLiveError(error)}`
    if (!runtime.startupOutput.includes(message)) runtime.startupOutput = [...runtime.startupOutput, message].slice(-80)
    console.warn(`[AgentLens] ${message}`)
  }

  private persistRuntimeBestEffort(runtime: OwnedRuntime): void {
    if (!this.recoveryStore) return
    const sessionPath = runtime.input.sessionPath?.trim()
    if (!sessionPath) return
    const pathKey = sessionPathKey(sessionPath)
    if (runtime.recoverySessionPath && sessionPathKey(runtime.recoverySessionPath) === pathKey) return
    if (runtime.recoveryCheckpointPending && sessionPathKey(runtime.recoveryCheckpointPending) === pathKey) return
    runtime.recoveryCheckpointPending = sessionPath
    const checkpoint = this.persistRuntime(runtime).catch(error => {
      this.recoveryDiagnostic(runtime, 'Pi Live recovery checkpoint failed', error)
    }).finally(() => {
      if (runtime.recoveryCheckpointPending && sessionPathKey(runtime.recoveryCheckpointPending) === pathKey) {
        runtime.recoveryCheckpointPending = undefined
      }
      if (runtime.recoveryCheckpointTask === checkpoint) runtime.recoveryCheckpointTask = undefined
    })
    runtime.recoveryCheckpointTask = checkpoint
  }

  private persistSessionIfChanged(runtime: OwnedRuntime, state: PiLiveRuntimeState): void {
    const nextPath = state.sessionFile?.trim()
    if (!nextPath) return
    this.adoptRuntimeSession(runtime, nextPath)
    this.persistRuntimeBestEffort(runtime)
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
          const resources = startupResources(event.resources)
          if (resources) {
            runtime.startupResources = resources
            runtime.startupAuditResources ??= copyStartupResources(resources)
            runtime.startupResourcesCapturedAt ??= new Date().toISOString()
          }
        } else if (event.type === 'package_updates') {
          runtime.packageUpdates = packageUpdates(event.updates)
          runtime.packageUpdateCheck = packageUpdateStatus(event.status) ?? runtime.packageUpdateCheck
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

      const requestedSessionPath = runtime.input.sessionPath?.trim()
      let readyState: PiLiveRuntimeState | undefined
      if (runtime.input.historyAction === 'fork' && requestedSessionPath) {
        const forkedState = await handle.state()
        if (!forkedState.sessionFile || sessionPathKey(forkedState.sessionFile) === sessionPathKey(requestedSessionPath)) {
          await handle.terminate().catch(() => undefined)
          runtime.handle = undefined
          throw new Error('Pi 分叉 Runtime 未切换到新的 Session，已拒绝继续')
        }
        this.adoptRuntimeSession(runtime, forkedState.sessionFile)
        readyState = forkedState
      } else if (runtime.input.historyAction === 'continue' && requestedSessionPath) {
        const continuedState = await handle.state()
        if (!continuedState.sessionFile || sessionPathKey(continuedState.sessionFile) !== sessionPathKey(requestedSessionPath)) {
          await handle.terminate().catch(() => undefined)
          runtime.handle = undefined
          throw new Error('Pi 继续 Runtime 未保持目标 Session，已拒绝继续')
        }
        this.adoptRuntimeSession(runtime, continuedState.sessionFile)
        readyState = continuedState
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

      if (readyState) {
        this.persistSessionIfChanged(runtime, readyState)
        this.updateRuntimeResources(runtime, readyState)
        this.persistStartupResourcesBestEffort(runtime, readyState)
      } else {
        let probe: Promise<void>
        probe = handle.state().then(state => {
          if (runtime.generation !== generation || runtime.status !== 'ready' || runtime.handle !== handle) return
          this.persistSessionIfChanged(runtime, state)
          this.updateRuntimeResources(runtime, state)
          this.persistStartupResourcesBestEffort(runtime, state)
        }).catch(error => {
          if (runtime.generation !== generation || runtime.status !== 'ready' || runtime.handle !== handle) return
          this.recoveryDiagnostic(runtime, 'Pi Live recovery state probe failed', error)
        }).finally(() => {
          if (runtime.startupAuditProbeTask === probe) runtime.startupAuditProbeTask = undefined
        })
        runtime.startupAuditProbeTask = probe
      }
    } catch (error) {
      if (runtime.generation !== generation || runtime.status === 'terminating' || runtime.status === 'terminated') return
      runtime.initializationElapsedMs = Math.max(0, Date.now() - runtime.initializationStartedAt)
      runtime.status = 'failed'
      runtime.error = formatLiveError(error)
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
    runtime.error = formatLiveError(error)
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
    this.updateRuntimeResources(runtime, snapshot.state)
    this.persistStartupResourcesBestEffort(runtime, snapshot.state)
    return { ...snapshot, state: this.decorateReadyState(runtime, snapshot.state) }
  }

  async controls(id: string): Promise<PiLiveControls> { return (await this.readyRuntime(id)).handle!.controls() }
  async setModel(id: string, provider: string, modelId: string): Promise<PiLiveRuntimeState> { const runtime = await this.readyRuntime(id); return this.decorateReadyState(runtime, await runtime.handle!.setModel(provider, modelId)) }
  async setThinkingLevel(id: string, level: string): Promise<PiLiveRuntimeState> { const runtime = await this.readyRuntime(id); return this.decorateReadyState(runtime, await runtime.handle!.setThinkingLevel(level)) }
  async prompt(id: string, message: string, behavior?: PiLiveStreamingBehavior): Promise<void> {
    if (!message.trim()) return
    const runtime = await this.readyRuntime(id)
    await runtime.handle!.prompt(message, behavior)
    this.captureTaskSummary(runtime, message)
  }
  async steer(id: string, message: string): Promise<void> {
    if (!message.trim()) return
    const runtime = await this.readyRuntime(id)
    await runtime.handle!.steer(message)
    this.captureTaskSummary(runtime, message)
  }
  async followUp(id: string, message: string): Promise<void> {
    if (!message.trim()) return
    const runtime = await this.readyRuntime(id)
    await runtime.handle!.followUp(message)
    this.captureTaskSummary(runtime, message)
  }
  async clearQueue(id: string): Promise<PiLiveQueueState> { return (await this.readyRuntime(id)).handle!.clearQueue() }
  async abort(id: string, options: { restoreQueue?: boolean } = {}): Promise<PiLiveQueueState> { return (await this.readyRuntime(id)).handle!.abort(options.restoreQueue !== false) }
  async respondToExtension(id: string, requestId: string, response: unknown): Promise<void> { if (!requestId) throw new Error('Pi extension request id is required'); await (await this.readyRuntime(id)).handle!.respondToExtension(requestId, response) }

  /** HTTP events calls state() before subscribe(), so lazy recovery is complete before this synchronous registration. */
  subscribe(id: string, listener: PiLiveRuntimeListener): () => void {
    const runtime = this.requireRuntime(id)
    return runtime.events.subscribe(listener)
  }

  async terminate(id: string): Promise<void> {
    await this.ensureRecoveryLoaded()
    const runtime = this.runtimes.get(id)
    if (runtime) {
      await runtime.startupAuditProbeTask?.catch(() => undefined)
      await runtime.startupAuditTask?.catch(() => undefined)
      await this.terminateRuntime(runtime, true)
      await runtime.recoveryCheckpointTask?.catch(() => undefined)
    }
    await this.recoveryStore?.remove(id)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.recoveryLoadPromise) await this.recoveryLoadPromise.catch(() => undefined)
    const runtimes = [...this.runtimes.values()]
    await Promise.allSettled(runtimes.map(async runtime => {
      await runtime.recoveryCheckpointTask?.catch(() => undefined)
      await runtime.startupAuditProbeTask?.catch(() => undefined)
      await runtime.startupAuditTask?.catch(() => undefined)
      if (runtime.status === 'ready' && runtime.handle) {
        const state = await runtime.handle.state().catch(() => undefined)
        if (state?.sessionFile) {
          this.adoptRuntimeSession(runtime, state.sessionFile)
          await this.persistRuntime(runtime).catch(error => this.recoveryDiagnostic(runtime, 'Pi Live recovery checkpoint failed', error))
        }
      }
      await this.terminateRuntime(runtime, false)
    }))
    await this.host.dispose?.().catch(() => undefined)
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
    runtime.events.clear()
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
      this.updateRuntimeResources(runtime, state)
      this.persistStartupResourcesBestEffort(runtime, state)
      return this.decorateReadyState(runtime, state)
    }
    return {
      runtimeSessionId: runtime.id,
      startedAt: runtime.createdAt,
      status: runtime.status,
      initializationStage: runtime.stage,
      initializationMessage: runtime.message,
      initializationElapsedMs: runtime.initializationElapsedMs,
      initializationTimings: runtime.initializationTimings,
      ...(runtime.startupResources ? { startupResources: runtime.startupResources } : {}),
      packageUpdateCheck: runtime.packageUpdateCheck,
      ...(runtime.packageUpdates.length ? { packageUpdates: runtime.packageUpdates } : {}),
      ...(runtime.startupOutput.length ? { startupOutput: runtime.startupOutput } : {}),
      ...(runtime.capabilities ? { capabilities: runtime.capabilities } : {}),
      ...(runtime.error ? { error: runtime.error } : {}),
      ...(runtime.input.name ? { sessionName: runtime.input.name } : {}),
      ...(runtime.taskSummary ? { taskSummary: runtime.taskSummary } : {}),
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
      startedAt: runtime.createdAt,
      status: 'ready',
      initializationStage: 'ready',
      initializationMessage: runtime.message,
      initializationElapsedMs: runtime.initializationElapsedMs,
      initializationTimings: runtime.initializationTimings,
      ...(runtime.startupResources ? { startupResources: runtime.startupResources } : {}),
      packageUpdateCheck: runtime.packageUpdateCheck,
      ...(runtime.packageUpdates.length ? { packageUpdates: runtime.packageUpdates } : {}),
      ...(runtime.startupOutput.length ? { startupOutput: runtime.startupOutput } : {}),
      ...(runtime.capabilities ? { capabilities: runtime.capabilities } : {}),
      ...(runtime.taskSummary ? { taskSummary: runtime.taskSummary } : {}),
      workspacePath: runtime.workspacePath,
      projectName: runtime.projectName,
      ...(runtime.gitBranch ? { gitBranch: runtime.gitBranch } : {}),
      ...(runtime.handle?.processId ? { processId: runtime.handle.processId } : {}),
    }
  }

  private updateRuntimeResources(runtime: OwnedRuntime, state: PiLiveRuntimeState): void {
    if (state.packageUpdateCheck) runtime.packageUpdateCheck = state.packageUpdateCheck
    if (state.packageUpdates) runtime.packageUpdates = [...state.packageUpdates]
    if (!state.startupResources) return
    runtime.startupResources = state.startupResources
    if (!runtime.startupAuditResources) {
      runtime.startupAuditResources = copyStartupResources(state.startupResources)
      runtime.startupResourcesCapturedAt ??= new Date().toISOString()
    }
  }

  private persistStartupResourcesBestEffort(runtime: OwnedRuntime, state: PiLiveRuntimeState): void {
    if (!this.startupAudit || !runtime.startupAuditResources) return
    const nativeSessionId = state.nativeSessionId?.trim()
    if (!nativeSessionId) return

    const attempt = `${runtime.generation}:${runtime.initializationStartedAt}`
    if (runtime.startupAuditCompleted === attempt || runtime.startupAuditPending === attempt) return

    const capturedAt = runtime.startupResourcesCapturedAt ?? new Date().toISOString()
    const snapshot = {
      runtimeSessionId: runtime.id,
      attemptStartedAt: new Date(runtime.initializationStartedAt).toISOString(),
      capturedAt,
      nativeSessionId,
      workspacePath: runtime.workspacePath,
      startupResources: copyStartupResources(runtime.startupAuditResources),
      ...(runtime.input.executable ? { executable: runtime.input.executable } : {}),
      ...(state.sdkVersion ?? runtime.capabilities?.sdkVersion
        ? { sdkVersion: state.sdkVersion ?? runtime.capabilities?.sdkVersion }
        : {}),
      ...(state.sessionName ?? runtime.input.name
        ? { sessionName: state.sessionName ?? runtime.input.name }
        : {}),
    }

    runtime.startupAuditPending = attempt
    let task: Promise<void>
    task = this.startupAudit.recordStartupResources(snapshot).then(() => {
      if (runtime.startupAuditPending === attempt) runtime.startupAuditCompleted = attempt
    }).catch(error => {
      console.warn('[AgentLens] Pi Live startup resource audit failed', error)
    }).finally(() => {
      if (runtime.startupAuditPending === attempt) runtime.startupAuditPending = undefined
      if (runtime.startupAuditTask === task) runtime.startupAuditTask = undefined
    })
    runtime.startupAuditTask = task
  }

  private captureTaskSummary(runtime: OwnedRuntime, message: string): void {
    if (runtime.taskSummary) return
    const summary = taskSummary(message)
    if (!summary) return
    runtime.taskSummary = summary
    this.publish(runtime, { type: 'task_summary', taskSummary: summary })
  }

  private publish(runtime: OwnedRuntime, event: Record<string, unknown>): void {
    runtime.events.publish(event)
  }
}
