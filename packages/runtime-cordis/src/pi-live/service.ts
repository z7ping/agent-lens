import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  LIVE_HISTORY_INDEX_QUERY_MAX_LIMIT,
  LIVE_SNAPSHOT_DEFAULT_LIMIT,
  LIVE_SNAPSHOT_MAX_LIMIT,
  type LiveContributionText,
  type LiveHistoryIndexQuery,
  type LiveRuntimeContributionField,
  type LiveRuntimeDisclosureContribution,
  type LiveSnapshotWindow,
} from '@agent-lens/core'
import { formatLiveError, LiveEventChannel } from '@agent-lens/live-support'
import { findPiExecutable, type PiSdkLoader } from './sdk-loader'
import { InProcessPiRuntimeHost } from './in-process-host'
import type { PiLiveRecoveryRecord, PiLiveRecoveryStore } from './recovery-store'
import { latestPiSessionEntryId } from './session-disk-tail'
import type { PiLiveStartupAuditSink } from './startup-audit'
import { WorkerPiRuntimeHost, type PiRuntimeHandle, type PiRuntimeHost } from './worker-host'
import { PiWorkspaceFileReferenceIndex } from './workspace-files'
import type { PiLiveAvailability, PiLiveCommand, PiLiveControls, PiLiveInitializationStage, PiLiveImageInput, PiLiveInitializationTiming, PiLivePackageUpdate, PiLivePackageUpdateCheckStatus, PiLiveQueueState, PiLiveRuntimeCapabilities, PiLiveRuntimeListener, PiLiveRuntimeState, PiLiveService, PiLiveSnapshot, PiLiveStartInput, PiLiveStartupResources, PiLiveStreamingBehavior } from './types'

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
  packageUpdateCheck?: PiLivePackageUpdateCheckStatus | undefined
  packageUpdatesCheckedAt?: string | undefined
  capabilities?: PiLiveRuntimeCapabilities | undefined
  workspacePath: string
  projectName: string
  gitBranch?: string | undefined
  taskSummary?: string | undefined
  activeAssistantMessageId?: string | undefined
  queue: PiLiveQueueState
  recoverySessionPath?: string | undefined
  recoveryCheckpointPending?: string | undefined
  recoveryCheckpointTask?: Promise<void> | undefined
  startupResourcesCapturedAt?: string | undefined
  startupAuditCompleted?: string | undefined
  startupAuditPending?: string | undefined
  startupAuditTask?: Promise<void> | undefined
  startupAuditProbeTask?: Promise<void> | undefined
  startupPackageAuditCompleted?: string | undefined
  startupPackageAuditPending?: string | undefined
  startupPackageAuditTask?: Promise<void> | undefined
  subscriberCount: number
  lastActiveAt: number
  idleTimer?: ReturnType<typeof setTimeout> | undefined
  suspended: boolean
  hydrationTask?: Promise<void> | undefined
  cachedState?: PiLiveRuntimeState | undefined
  pendingExtensionRequestIds: Set<string>
}

interface PiLiveRuntimeLifecycleOptions {
  idleTimeoutMs?: number | undefined
}

const DEFAULT_PI_LIVE_IDLE_TIMEOUT_MS = 10 * 60_000

function taskSummary(message: string): string | undefined {
  const normalized = message.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, 240) : undefined
}


function contributionText(defaultText: string, zhCN: string): LiveContributionText {
  return {
    default: defaultText,
    localizations: {
      'zh-CN': zhCN,
      'en-US': defaultText,
    },
  }
}

function contributionDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const ms = Math.max(0, value)
  if (ms < 1) return '<1ms'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

const PI_STAGE_LABELS: Record<PiLiveInitializationStage, { en: string; zh: string }> = {
  starting_worker: { en: 'Starting worker', zh: '启动 Worker' },
  loading_sdk: { en: 'Loading SDK', zh: '加载 SDK' },
  loading_resources: { en: 'Loading resources', zh: '加载资源' },
  creating_session: { en: 'Creating session', zh: '创建会话' },
  binding_extensions: { en: 'Binding extensions', zh: '绑定扩展' },
  ready: { en: 'Ready', zh: '就绪' },
}

function stageLabel(stage: PiLiveInitializationStage | undefined): { en: string; zh: string } | undefined {
  return stage ? PI_STAGE_LABELS[stage] : undefined
}

function runtimeStatusLabel(status: PiLiveRuntimeState['status']): { en: string; zh: string } {
  if (status === 'failed') return { en: 'Failed', zh: '失败' }
  if (status === 'initializing') return { en: 'Initializing', zh: '初始化中' }
  if (status === 'terminating') return { en: 'Terminating', zh: '正在终止' }
  if (status === 'terminated') return { en: 'Terminated', zh: '已终止' }
  return { en: 'Ready', zh: '就绪' }
}

function runtimeDisclosureFields(state: PiLiveRuntimeState): LiveRuntimeContributionField[] {
  const fields: LiveRuntimeContributionField[] = []
  const currentStage = stageLabel(state.initializationStage)
  if (currentStage) {
    fields.push({
      label: contributionText('Current stage', '当前阶段'),
      value: contributionText(currentStage.en, currentStage.zh),
    })
  }

  const elapsed = state.initializationElapsedMs
    ?? state.initializationTimings?.reduce((sum, item) => sum + Math.max(0, item.durationMs), 0)
  if (elapsed !== undefined) {
    fields.push({
      label: contributionText('Initialization elapsed', '初始化耗时'),
      value: contributionDuration(elapsed),
    })
  }

  if (state.initializationTimings?.length) {
    fields.push({
      label: contributionText('Initialization stages', '初始化阶段'),
      kind: 'list' as const,
      values: state.initializationTimings.map(item => {
        const label = stageLabel(item.stage)
        const duration = contributionDuration(item.durationMs)
        return label
          ? contributionText(`${label.en} · ${duration}`, `${label.zh} · ${duration}`)
          : `${item.stage} · ${duration}`
      }),
    })
  }

  const sdkVersion = state.sdkVersion ?? state.capabilities?.sdkVersion
  if (sdkVersion) {
    fields.push({
      label: contributionText('Pi SDK', 'Pi SDK'),
      value: sdkVersion,
    })
  }
  if (state.runtimeMode) {
    fields.push({
      label: contributionText('Runtime mode', '运行时模式'),
      value: state.runtimeMode === 'session_runtime'
        ? contributionText('Session Runtime', 'Session Runtime')
        : contributionText('Compatibility', '兼容模式'),
    })
  }
  if (state.processId !== undefined) {
    fields.push({
      label: contributionText('Worker PID', 'Worker PID'),
      value: String(state.processId),
    })
  }

  const resources = state.startupResources
  const resourceGroups: Array<[string, string, string[] | undefined]> = [
    ['Contexts', '上下文', resources?.contexts],
    ['Skills', '技能', resources?.skills],
    ['Prompts', '提示词', resources?.prompts],
    ['Extensions', '扩展', resources?.extensions],
    ['Themes', '主题', resources?.themes],
  ]
  for (const [en, zh, values] of resourceGroups) {
    if (!values?.length) continue
    fields.push({
      label: contributionText(en, zh),
      kind: 'list' as const,
      values,
    })
  }

  if (state.packageUpdates?.length) {
    fields.push({
      label: contributionText('Package updates', '可用包更新'),
      kind: 'list' as const,
      values: state.packageUpdates.map(item => contributionText(
        `${item.displayName} · ${item.scope} · ${item.type}`,
        `${item.displayName} · ${item.scope === 'project' ? '项目' : '用户'} · ${item.type}`,
      )),
    })
  }
  if (state.packageUpdateCheck === 'failed') {
    fields.push({
      label: contributionText('Package update check', '包更新检查'),
      value: contributionText('Failed', '失败'),
    })
  }
  if (resources?.diagnostics.length) {
    fields.push({
      label: contributionText('Resource diagnostics', '资源诊断'),
      kind: 'code' as const,
      values: resources.diagnostics,
    })
  }
  if (state.startupOutput?.length) {
    fields.push({
      label: contributionText('Startup output', '启动输出'),
      kind: 'code' as const,
      values: state.startupOutput,
    })
  }
  if (state.error) {
    fields.push({
      label: contributionText('Runtime error', '运行时错误'),
      kind: 'code' as const,
      value: state.error,
    })
  }
  return fields
}

interface PiUserMessageEntryTarget {
  entryId: string
  parentId: string | null
  text: string
}

function messageContentText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value
    .flatMap(part => {
      const row = record(part)
      return row.type === 'text' && typeof row.text === 'string' ? [row.text] : []
    })
    .join('')
    .trim()
}

function piUserMessageEntry(entries: readonly unknown[], entryId: string): PiUserMessageEntryTarget {
  const value = entries.find(entry => record(entry).id === entryId)
  const row = record(value)
  const message = record(row.message)
  if (row.type !== 'message' || message.role !== 'user') {
    throw new Error('Pi message action requires a persisted user message entry')
  }
  const parentId = row.parentId
  if (parentId !== null && typeof parentId !== 'string') {
    throw new Error('Pi user message entry has an invalid parentId')
  }
  return {
    entryId,
    parentId,
    text: messageContentText(message.content),
  }
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

function queueMessages(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function textList(value: unknown, limit = 240): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))].slice(0, limit)
}

function startupResources(value: unknown): PiLiveStartupResources | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const resources = record(value)
  return {
    contexts: textList(resources.contexts),
    skills: textList(resources.skills),
    prompts: textList(resources.prompts),
    extensions: textList(resources.extensions),
    themes: textList(resources.themes),
    diagnostics: textList(resources.diagnostics, 80),
  }
}

function packageUpdates(value: unknown): PiLivePackageUpdate[] {
  if (!Array.isArray(value)) return []
  const updates: PiLivePackageUpdate[] = []
  for (const item of value) {
    const row = record(item)
    if (typeof row.displayName !== 'string') continue
    const displayName = row.displayName.trim()
    if (!displayName) continue
    if (row.type !== 'npm' && row.type !== 'git') continue
    if (row.scope !== 'user' && row.scope !== 'project') continue
    updates.push({
      displayName: displayName.slice(0, 240),
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

function finalPackageUpdateStatus(
  value: PiLivePackageUpdateCheckStatus | undefined,
): Exclude<PiLivePackageUpdateCheckStatus, 'checking'> | undefined {
  return value === 'complete' || value === 'unavailable' || value === 'failed' ? value : undefined
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
    ...(typeof capabilities.treeNavigation === 'boolean' ? { treeNavigation: capabilities.treeNavigation } : {}),
    ...(typeof capabilities.messageFork === 'boolean' ? { messageFork: capabilities.messageFork } : {}),
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
  private readonly workspaceFiles = new PiWorkspaceFileReferenceIndex()
  private availabilityPromise: Promise<PiLiveAvailability> | null = null
  private recoveryLoadPromise: Promise<void> | null = null
  private recoveryLoaded = false
  private disposed = false
  private readonly idleTimeoutMs: number

  constructor(
    dependency?: PiSdkLoader | PiRuntimeHost,
    recoveryStore?: PiLiveRecoveryStore,
    private readonly startupAudit?: PiLiveStartupAuditSink,
    lifecycle: PiLiveRuntimeLifecycleOptions = {},
  ) {
    this.host = typeof dependency === 'function' ? new InProcessPiRuntimeHost(dependency) : dependency ?? new WorkerPiRuntimeHost()
    this.recoveryStore = recoveryStore
    this.idleTimeoutMs = Number.isFinite(lifecycle.idleTimeoutMs)
      ? Math.max(0, lifecycle.idleTimeoutMs!)
      : DEFAULT_PI_LIVE_IDLE_TIMEOUT_MS
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
      if (duplicate) return this.state(duplicate.id)
    }
    const runtime = this.createRuntime(randomUUID(), input, false)
    this.runtimes.set(runtime.id, runtime)

    // Historical Resume/Fork is navigation-first: return a Logical Runtime
    // before starting any Worker so the HTTP response and SSE subscription can
    // be established before Pi emits initialization progress.
    if (input.sessionPath && input.historyAction) {
      runtime.status = 'ready'
      runtime.stage = 'ready'
      runtime.message = 'Pi Runtime 等待前台恢复'
      runtime.suspended = true
      return this.foregroundRuntimeState(runtime)
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
    runtime.startupAuditResources = undefined
    runtime.startupResourcesCapturedAt = undefined
    runtime.startupAuditCompleted = undefined
    runtime.startupAuditPending = undefined
    runtime.startupAuditTask = undefined
    runtime.startupAuditProbeTask = undefined
    runtime.startupPackageAuditCompleted = undefined
    runtime.startupPackageAuditPending = undefined
    runtime.startupPackageAuditTask = undefined
    runtime.startupOutput = []
    runtime.packageUpdates = []
    runtime.packageUpdateCheck = undefined
    runtime.packageUpdatesCheckedAt = undefined
    runtime.capabilities = undefined
    runtime.activeAssistantMessageId = undefined
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
      queue: { steering: [], followUp: [] },
      subscriberCount: 0,
      lastActiveAt: now,
      suspended: false,
      pendingExtensionRequestIds: new Set<string>(),
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
      runtime.taskSummary = item.taskSummary
      runtime.status = 'ready'
      runtime.stage = 'ready'
      runtime.message = 'Pi Runtime 可恢复'
      runtime.suspended = true
      this.runtimes.set(runtime.id, runtime)
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
      ...(runtime.taskSummary ? { taskSummary: runtime.taskSummary } : {}),
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

  private persistRuntimeMetadataBestEffort(runtime: OwnedRuntime): void {
    if (!this.recoveryStore || !runtime.input.sessionPath?.trim()) return
    const previous = runtime.recoveryCheckpointTask
    let checkpoint: Promise<void>
    checkpoint = (async () => {
      await previous?.catch(() => undefined)
      await this.persistRuntime(runtime)
    })().catch(error => {
      this.recoveryDiagnostic(runtime, 'Pi Live recovery metadata checkpoint failed', error)
    }).finally(() => {
      if (runtime.recoveryCheckpointTask === checkpoint) runtime.recoveryCheckpointTask = undefined
    })
    runtime.recoveryCheckpointTask = checkpoint
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
            this.updateStartupAuditCandidate(runtime, resources)
          }
        } else if (event.type === 'package_updates') {
          runtime.packageUpdates = packageUpdates(event.updates)
          runtime.packageUpdateCheck = packageUpdateStatus(event.status) ?? runtime.packageUpdateCheck
          if (finalPackageUpdateStatus(runtime.packageUpdateCheck)) {
            runtime.packageUpdatesCheckedAt = new Date().toISOString()
            this.persistPackageUpdatesBestEffort(runtime, generation)
          }
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
        this.persistStartupAuditBestEffort(runtime, readyState)
        this.persistPackageUpdatesBestEffort(runtime, generation)
      } else {
        let probe: Promise<void>
        probe = handle.state().then(state => {
          if (runtime.generation !== generation || runtime.status !== 'ready' || runtime.handle !== handle) return
          this.persistSessionIfChanged(runtime, state)
          this.updateRuntimeResources(runtime, state)
          this.persistStartupAuditBestEffort(runtime, state)
          this.persistPackageUpdatesBestEffort(runtime, generation)
        }).catch(error => {
          if (runtime.generation !== generation || runtime.status !== 'ready' || runtime.handle !== handle) return
          this.recoveryDiagnostic(runtime, 'Pi Live recovery state probe failed', error)
        }).finally(() => {
          if (runtime.startupAuditProbeTask === probe) runtime.startupAuditProbeTask = undefined
        })
        runtime.startupAuditProbeTask = probe
      }
      this.scheduleIdleCheck(runtime)
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
    const runtime = await this.runtime(id)
    this.markRuntimeActive(runtime)
    // Foreground state is observational only. A suspended Logical Runtime is
    // presented as initializing, but Worker hydration starts only after an SSE
    // subscriber is attached (or an operation explicitly requires readiness).
    return this.foregroundRuntimeState(runtime)
  }


  async runtimeDisclosures(id: string): Promise<LiveRuntimeDisclosureContribution[]> {
    const state = await this.state(id)
    const status = runtimeStatusLabel(state.status)
    const elapsed = state.initializationElapsedMs
      ?? state.initializationTimings?.reduce((sum, item) => sum + Math.max(0, item.durationMs), 0)
    const duration = contributionDuration(elapsed)
    return [{
      contributionId: 'pi.runtime.diagnostics',
      title: contributionText('Runtime diagnostics', '运行时诊断'),
      summary: contributionText(
        `${status.en} · ${duration}`,
        `${status.zh} · ${duration}`,
      ),
      tone: state.status === 'failed'
        ? 'danger' as const
        : state.status === 'initializing'
          ? 'info' as const
          : 'neutral' as const,
      defaultExpanded: state.status === 'failed' || state.status === 'initializing',
      fields: runtimeDisclosureFields(state),
      ...(state.status === 'failed'
        ? {
            actions: [{
              actionId: 'pi.runtime.retry',
              label: contributionText('Retry', '重试'),
              description: contributionText(
                'Restart this failed Pi Runtime with the same task context.',
                '使用相同任务上下文重新启动失败的 Pi Runtime。',
              ),
              tone: 'primary' as const,
            }],
          }
        : {}),
    }]
  }

  async executeRuntimeAction(id: string, actionId: string) {
    if (actionId !== 'pi.runtime.retry') {
      throw this.conflict(`Unknown Pi runtime action: ${actionId}`)
    }
    return { runtime: await this.retry(id) }
  }

  async snapshot(id: string, since?: string, window?: LiveSnapshotWindow): Promise<PiLiveSnapshot> {
    const runtime = await this.runtime(id)
    this.markRuntimeActive(runtime)
    // Snapshot is an observational foreground read too. A suspended Worker
    // returns a partial empty window immediately; the subscribed Live channel
    // starts hydration and the ready event triggers bounded recovery.
    if (!runtime.handle || runtime.status !== 'ready') return { state: await this.foregroundRuntimeState(runtime), entries: [], leafId: null, page: { hasEarlier: false } }
    const selectors = [since, window?.before, window?.after, window?.edge, window?.around].filter(Boolean)
    if (selectors.length > 1) throw new Error('Live snapshot accepts only one cursor or edge selector')

    // Only mount/recovery reads probe disk. Pagination and rail jumps stay purely
    // in-memory so a long Session cannot turn into repeated filesystem work.
    const mountOrRecoveryRead = !window?.before && !window?.after && !window?.edge && !window?.around
    const externalState = mountOrRecoveryRead
      ? await this.externallyUpdatedRuntimeState(runtime)
      : undefined
    if (!runtime.handle || runtime.status !== 'ready') return { state: await this.runtimeState(runtime), entries: [], leafId: null, page: { hasEarlier: false } }

    const requestedLimit = window?.limit
    const limit = Number.isInteger(requestedLimit)
      ? Math.max(1, Math.min(LIVE_SNAPSHOT_MAX_LIMIT, requestedLimit!))
      : LIVE_SNAPSHOT_DEFAULT_LIMIT
    const boundedWindow: LiveSnapshotWindow = {
      ...(window?.before ? { before: window.before } : {}),
      ...(window?.after ? { after: window.after } : {}),
      ...(window?.edge ? { edge: window.edge } : {}),
      ...(window?.around ? { around: window.around } : {}),
      limit,
    }
    const handle = runtime.handle
    try {
      const snapshot = await handle.snapshot(since, boundedWindow)
      this.persistSessionIfChanged(runtime, snapshot.state)
      this.updateRuntimeResources(runtime, snapshot.state)
      this.persistStartupAuditBestEffort(runtime, snapshot.state)
      this.persistPackageUpdatesBestEffort(runtime, runtime.generation)
      return { ...snapshot, state: this.decorateReadyState(runtime, snapshot.state) }
    } finally {
      // Disk-ahead invalidation is a background lifecycle concern. The current
      // bounded Snapshot is returned first; subscribers then observe the Worker
      // rebuild and reconcile to the externally appended Session.
      if (externalState && runtime.handle === handle && runtime.status === 'ready') {
        this.scheduleRuntimeRestart(runtime, externalState, '检测到外部 Pi 会话更新，正在重新加载')
      }
    }
  }

  async historyIndex(id: string, query: LiveHistoryIndexQuery = {}) {
    const runtime = await this.readyRuntime(id)
    const requestedLimit = Number.isInteger(query.limit) ? query.limit! : 0
    const boundedQuery: LiveHistoryIndexQuery = {
      ...(Number.isInteger(query.fromOrdinal) && query.fromOrdinal! > 0
        ? { fromOrdinal: query.fromOrdinal }
        : {}),
      ...(query.cursor?.trim() ? { cursor: query.cursor.trim() } : {}),
      limit: Math.max(0, Math.min(LIVE_HISTORY_INDEX_QUERY_MAX_LIMIT, requestedLimit)),
    }
    if (boundedQuery.cursor && boundedQuery.fromOrdinal !== undefined) {
      throw new Error('Live history index accepts cursor or fromOrdinal, not both')
    }
    return runtime.handle?.historyIndex
      ? runtime.handle.historyIndex(boundedQuery)
      : { total: 0, items: [] }
  }

  async commands(id: string): Promise<PiLiveCommand[]> {
    const runtime = await this.readyRuntime(id)
    return runtime.handle!.commands ? runtime.handle!.commands() : []
  }

  async workspaceFileReferences(id: string, query: string, limit = 20) {
    const runtime = await this.runtime(id)
    return this.workspaceFiles.search(runtime.workspacePath, query, limit)
  }
  async messageActions(id: string) {
    const runtime = await this.readyRuntime(id)
    const state = await this.runtimeState(runtime)

    const actions = []
    if (runtime.handle?.entry && runtime.handle.navigateTree && state.capabilities?.treeNavigation === true) {
      actions.push({
        actionId: 'pi.edit-from-here',
        label: {
          default: 'Edit from here',
          localizations: { 'zh-CN': '从这里编辑', 'en-US': 'Edit from here' },
        },
        description: {
          default: 'Move this session back before this message and restore its text to the composer.',
          localizations: {
            'zh-CN': '当前会话回到这条消息之前，并把原消息恢复到输入框。',
            'en-US': 'Move this session back before this message and restore its text to the composer.',
          },
        },
        roles: ['user'] as const,
        requiresIdle: true,
      })
    }
    if (runtime.handle?.entry && state.sessionFile && state.capabilities?.messageFork === true) {
      actions.push({
        actionId: 'pi.new-session-from-here',
        label: {
          default: 'New session',
          localizations: { 'zh-CN': '从这里新建会话', 'en-US': 'New session' },
        },
        description: {
          default: 'Create an independent session from before this message.',
          localizations: {
            'zh-CN': '从这条消息之前创建一个独立会话，并把原消息放回输入框。',
            'en-US': 'Create an independent session from before this message.',
          },
        },
        roles: ['user'] as const,
        requiresIdle: true,
      })
    }
    return actions
  }

  async executeMessageAction(id: string, actionId: string, targetEntryId: string) {
    if (!targetEntryId) throw new Error('Pi message action target entry id is required')
    const runtime = await this.readyRuntime(id)
    const state = await runtime.handle!.state()
    if (state.isStreaming) {
      throw this.conflict('Pi message actions require an idle session')
    }
    if (!runtime.handle!.entry) throw this.conflict('Pi Runtime does not expose targeted entry lookup')
    const targetEntry = await runtime.handle!.entry(targetEntryId)
    const target = piUserMessageEntry(targetEntry ? [targetEntry] : [], targetEntryId)

    if (actionId === 'pi.edit-from-here') {
      if (state.capabilities?.treeNavigation !== true || !runtime.handle?.navigateTree) {
        throw this.conflict('Installed Pi SDK does not support Edit from here')
      }
      const result = await runtime.handle.navigateTree(target.entryId)
      if (result.cancelled) return { outcome: 'refresh-current' as const }
      return {
        outcome: 'refresh-current' as const,
        ...(typeof result.editorText === 'string'
          ? { draftText: result.editorText }
          : target.text
            ? { draftText: target.text }
            : {}),
      }
    }

    if (actionId === 'pi.new-session-from-here') {
      if (state.capabilities?.messageFork !== true) {
        throw this.conflict('Installed Pi SDK does not support message-level session fork')
      }
      if (!state.sessionFile) throw this.conflict('Pi session must be persisted before creating a new session from a message')
      const nextInput: PiLiveStartInput = {
        cwd: runtime.input.cwd,
        sessionPath: state.sessionFile,
        historyAction: 'fork',
        branchFromEntryId: target.parentId,
      }
      const next = await this.start(nextInput)
      return {
        outcome: 'open-runtime' as const,
        runtime: next,
        ...(target.text ? { draftText: target.text } : {}),
      }
    }

    throw new Error(`Unknown Pi message action: ${actionId}`)
  }

  async controls(id: string): Promise<PiLiveControls> { return (await this.readyRuntime(id)).handle!.controls() }
  async setModel(id: string, provider: string, modelId: string): Promise<PiLiveRuntimeState> {
    const runtime = await this.readyRuntime(id)
    const state = await runtime.handle!.setModel(provider, modelId)
    this.updateRuntimeResources(runtime, state)
    this.persistStartupAuditBestEffort(runtime, state)
    this.persistPackageUpdatesBestEffort(runtime, runtime.generation)
    return this.decorateReadyState(runtime, state)
  }
  async setThinkingLevel(id: string, level: string): Promise<PiLiveRuntimeState> {
    const runtime = await this.readyRuntime(id)
    const state = await runtime.handle!.setThinkingLevel(level)
    this.updateRuntimeResources(runtime, state)
    this.persistStartupAuditBestEffort(runtime, state)
    this.persistPackageUpdatesBestEffort(runtime, runtime.generation)
    return this.decorateReadyState(runtime, state)
  }
  async prompt(id: string, message: string, behavior?: PiLiveStreamingBehavior, images?: readonly PiLiveImageInput[]): Promise<void> {
    if (!message.trim() && !images?.length) return
    const runtime = await this.readyRuntime(id)
    await runtime.handle!.prompt(message, behavior, images)
    if (message.trim()) this.captureTaskSummary(runtime, message)
  }
  async steer(id: string, message: string, images?: readonly PiLiveImageInput[]): Promise<void> {
    if (!message.trim() && !images?.length) return
    const runtime = await this.readyRuntime(id)
    await runtime.handle!.steer(message, images)
    if (message.trim()) this.captureTaskSummary(runtime, message)
  }
  async followUp(id: string, message: string, images?: readonly PiLiveImageInput[]): Promise<void> {
    if (!message.trim() && !images?.length) return
    const runtime = await this.readyRuntime(id)
    await runtime.handle!.followUp(message, images)
    if (message.trim()) this.captureTaskSummary(runtime, message)
  }
  async queueState(id: string): Promise<PiLiveQueueState> {
    const runtime = await this.readyRuntime(id)
    return {
      steering: [...runtime.queue.steering],
      followUp: [...runtime.queue.followUp],
    }
  }
  async clearQueue(id: string): Promise<PiLiveQueueState> {
    const runtime = await this.readyRuntime(id)
    const queue = await runtime.handle!.clearQueue()
    runtime.queue = { steering: [], followUp: [] }
    return queue
  }
  async abort(id: string, options: { restoreQueue?: boolean } = {}): Promise<PiLiveQueueState> {
    const runtime = await this.readyRuntime(id)
    const queue = await runtime.handle!.abort(options.restoreQueue !== false)
    runtime.queue = { steering: [], followUp: [] }
    runtime.activeAssistantMessageId = undefined
    return queue
  }
  async respondToExtension(id: string, requestId: string, response: unknown): Promise<void> {
    if (!requestId) throw new Error('Pi extension request id is required')
    const runtime = await this.readyRuntime(id)
    await runtime.handle!.respondToExtension(requestId, response)
    runtime.pendingExtensionRequestIds.delete(requestId)
    this.markRuntimeActive(runtime)
  }

  /** Subscribe first, then trigger hydration so initialization progress is observable from the first stage. */
  subscribe(id: string, listener: PiLiveRuntimeListener): () => void {
    const runtime = this.requireRuntime(id)
    runtime.subscriberCount += 1
    this.markRuntimeActive(runtime)
    const unsubscribe = runtime.events.subscribe(listener)
    void this.ensureRuntimeHydrated(runtime).catch(error => {
      this.recoveryDiagnostic(runtime, 'Pi Live background hydration failed', error)
    })
    return () => {
      unsubscribe()
      runtime.subscriberCount = Math.max(0, runtime.subscriberCount - 1)
      runtime.lastActiveAt = Date.now()
      this.scheduleIdleCheck(runtime)
    }
  }

  async terminate(id: string): Promise<void> {
    await this.ensureRecoveryLoaded()
    const runtime = this.runtimes.get(id)
    if (runtime) {
      await runtime.startupAuditProbeTask?.catch(() => undefined)
      if (runtime.status === 'ready' && runtime.handle) {
        const state = await runtime.handle.state().catch(() => undefined)
        if (state) {
          this.persistSessionIfChanged(runtime, state)
          this.updateRuntimeResources(runtime, state)
          this.persistStartupAuditBestEffort(runtime, state)
          this.persistPackageUpdatesBestEffort(runtime, runtime.generation)
        }
      }
      await runtime.startupAuditTask?.catch(() => undefined)
      await runtime.startupPackageAuditTask?.catch(() => undefined)
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
      await runtime.startupPackageAuditTask?.catch(() => undefined)
      if (runtime.status === 'ready' && runtime.handle) {
        const state = await runtime.handle.state().catch(() => undefined)
        if (state) {
          if (state.sessionFile) {
            this.adoptRuntimeSession(runtime, state.sessionFile)
            await this.persistRuntime(runtime).catch(error => this.recoveryDiagnostic(runtime, 'Pi Live recovery checkpoint failed', error))
          }
          this.updateRuntimeResources(runtime, state)
          this.persistStartupAuditBestEffort(runtime, state)
          this.persistPackageUpdatesBestEffort(runtime, runtime.generation)
          await runtime.startupAuditTask?.catch(() => undefined)
          await runtime.startupPackageAuditTask?.catch(() => undefined)
        }
      }
      await this.terminateRuntime(runtime, false)
    }))
    await this.host.dispose?.().catch(() => undefined)
  }

  private async terminateRuntime(runtime: OwnedRuntime, explicit: boolean): Promise<void> {
    this.clearIdleTimer(runtime)
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

  private clearIdleTimer(runtime: OwnedRuntime): void {
    if (runtime.idleTimer !== undefined) clearTimeout(runtime.idleTimer)
    runtime.idleTimer = undefined
  }

  private markRuntimeActive(runtime: OwnedRuntime): void {
    runtime.lastActiveAt = Date.now()
    this.clearIdleTimer(runtime)
    if (runtime.subscriberCount === 0) this.scheduleIdleCheck(runtime)
  }

  private scheduleIdleCheck(runtime: OwnedRuntime): void {
    this.clearIdleTimer(runtime)
    if (this.disposed || this.idleTimeoutMs <= 0 || runtime.suspended
      || runtime.status !== 'ready' || !runtime.handle || runtime.subscriberCount > 0) return
    const elapsed = Math.max(0, Date.now() - runtime.lastActiveAt)
    const delay = Math.max(1, this.idleTimeoutMs - elapsed)
    const timer = setTimeout(() => {
      if (runtime.idleTimer === timer) runtime.idleTimer = undefined
      void this.suspendIdleRuntime(runtime)
    }, delay)
    ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
    runtime.idleTimer = timer
  }

  private runtimeIsQuiescent(runtime: OwnedRuntime, state: PiLiveRuntimeState): boolean {
    return !state.isStreaming
      && !state.isCompacting
      && state.pendingMessageCount === 0
      && !runtime.activeAssistantMessageId
      && runtime.queue.steering.length === 0
      && runtime.queue.followUp.length === 0
      && runtime.pendingExtensionRequestIds.size === 0
  }

  private async checkpointRuntimeState(runtime: OwnedRuntime, state: PiLiveRuntimeState): Promise<boolean> {
    const sessionPath = state.sessionFile?.trim() || runtime.input.sessionPath?.trim()
    if (!sessionPath) return false
    this.adoptRuntimeSession(runtime, sessionPath)
    this.updateRuntimeResources(runtime, state)
    this.persistStartupAuditBestEffort(runtime, state)
    this.persistPackageUpdatesBestEffort(runtime, runtime.generation)
    await runtime.recoveryCheckpointTask?.catch(() => undefined)
    await this.persistRuntime(runtime).catch(error => {
      this.recoveryDiagnostic(runtime, 'Pi Live recovery checkpoint failed', error)
    })
    return true
  }

  private prepareRuntimeInitialization(runtime: OwnedRuntime, message: string): number {
    const now = Date.now()
    this.clearIdleTimer(runtime)
    runtime.generation += 1
    runtime.initialization.abort()
    runtime.initialization = new AbortController()
    runtime.status = 'initializing'
    runtime.stage = 'starting_worker'
    runtime.message = message
    runtime.error = undefined
    runtime.handle = undefined
    runtime.suspended = false
    runtime.cachedState = undefined
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
    runtime.startupPackageAuditCompleted = undefined
    runtime.startupPackageAuditPending = undefined
    runtime.startupPackageAuditTask = undefined
    runtime.startupOutput = []
    runtime.packageUpdates = []
    runtime.packageUpdateCheck = undefined
    runtime.packageUpdatesCheckedAt = undefined
    runtime.capabilities = undefined
    runtime.activeAssistantMessageId = undefined
    runtime.pendingExtensionRequestIds.clear()
    runtime.queue = { steering: [], followUp: [] }
    runtime.lastActiveAt = now
    this.publish(runtime, { type: 'runtime_status', status: runtime.status, stage: runtime.stage, message: runtime.message })
    return runtime.generation
  }

  private ensureRuntimeHydrated(runtime: OwnedRuntime): Promise<void> {
    if (runtime.hydrationTask) return runtime.hydrationTask
    if (!runtime.suspended || this.disposed) return Promise.resolve()

    // Hydration is kicked off synchronously so callers immediately observe the
    // initializing state, but the Worker startup itself always stays in the
    // background unless an operation explicitly requires a ready Runtime.
    const generation = this.prepareRuntimeInitialization(runtime, '正在恢复 Pi Runtime')
    let task: Promise<void>
    task = this.initialize(runtime, generation).finally(() => {
      if (runtime.hydrationTask === task) runtime.hydrationTask = undefined
    })
    runtime.hydrationTask = task
    return task
  }

  private async suspendIdleRuntime(runtime: OwnedRuntime): Promise<void> {
    if (this.disposed || runtime.suspended || runtime.status !== 'ready'
      || !runtime.handle || runtime.subscriberCount > 0 || this.idleTimeoutMs <= 0) return

    const elapsed = Math.max(0, Date.now() - runtime.lastActiveAt)
    if (elapsed < this.idleTimeoutMs) {
      this.scheduleIdleCheck(runtime)
      return
    }

    const handle = runtime.handle
    const state = await handle.state().catch(error => {
      this.recoveryDiagnostic(runtime, 'Pi Live idle state probe failed', error)
      return undefined
    })
    if (!state || runtime.handle !== handle || runtime.status !== 'ready') return

    if (!this.runtimeIsQuiescent(runtime, state)) {
      runtime.lastActiveAt = Date.now()
      this.scheduleIdleCheck(runtime)
      return
    }
    if (!await this.checkpointRuntimeState(runtime, state)) {
      runtime.lastActiveAt = Date.now()
      this.scheduleIdleCheck(runtime)
      return
    }

    const cachedState = this.decorateReadyState(runtime, state)
    delete cachedState.processId
    runtime.cachedState = cachedState
    runtime.generation += 1
    runtime.initialization.abort()
    runtime.handle = undefined
    runtime.suspended = true
    runtime.status = 'ready'
    runtime.stage = 'ready'
    runtime.message = 'Pi Runtime 已挂起，可自动恢复'
    runtime.activeAssistantMessageId = undefined
    runtime.pendingExtensionRequestIds.clear()
    runtime.queue = { steering: [], followUp: [] }
    this.clearIdleTimer(runtime)
    await handle.terminate().catch(() => undefined)
  }

  private async restartRuntimeWorker(
    runtime: OwnedRuntime,
    state: PiLiveRuntimeState,
    message: string,
  ): Promise<void> {
    const handle = runtime.handle
    if (!handle || !await this.checkpointRuntimeState(runtime, state)) return
    const generation = this.prepareRuntimeInitialization(runtime, message)
    await handle.terminate().catch(() => undefined)
    await this.initialize(runtime, generation)
  }

  private async externallyUpdatedRuntimeState(runtime: OwnedRuntime): Promise<PiLiveRuntimeState | undefined> {
    const handle = runtime.handle
    if (!handle?.entry || runtime.status !== 'ready') return undefined
    const state = await handle.state().catch(() => undefined)
    if (!state || runtime.handle !== handle || !this.runtimeIsQuiescent(runtime, state)) return undefined
    const sessionFile = state.sessionFile?.trim() || runtime.input.sessionPath?.trim()
    if (!sessionFile) return undefined

    let latestEntryId: string | undefined
    try {
      latestEntryId = await latestPiSessionEntryId(sessionFile)
    } catch (error) {
      this.recoveryDiagnostic(runtime, 'Pi Live external session probe failed', error)
      return undefined
    }
    if (!latestEntryId || runtime.handle !== handle) return undefined

    const known = await handle.entry(latestEntryId).catch(() => null)
    return known ? undefined : state
  }

  private scheduleRuntimeRestart(
    runtime: OwnedRuntime,
    state: PiLiveRuntimeState,
    message: string,
  ): void {
    if (runtime.hydrationTask) return
    let task: Promise<void>
    task = this.restartRuntimeWorker(runtime, state, message).finally(() => {
      if (runtime.hydrationTask === task) runtime.hydrationTask = undefined
    })
    runtime.hydrationTask = task
    void task.catch(error => {
      this.recoveryDiagnostic(runtime, 'Pi Live background Worker refresh failed', error)
    })
  }

  private conflict(message: string): Error { const error = new Error(message) as Error & { statusCode?: number }; error.statusCode = 409; return error }

  private async runtime(id: string): Promise<OwnedRuntime> {
    await this.ensureRecoveryLoaded()
    return this.requireRuntime(id)
  }

  private async readyRuntime(id: string): Promise<OwnedRuntime> {
    const runtime = await this.runtime(id)
    this.markRuntimeActive(runtime)
    await this.ensureRuntimeHydrated(runtime)
    if (runtime.status !== 'ready' || !runtime.handle) throw this.conflict(`Pi Live runtime is not ready: ${runtime.status}`)
    return runtime
  }

  private requireRuntime(id: string): OwnedRuntime {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error(`Unknown Pi Live runtime session: ${id}`)
    return runtime
  }

  private async foregroundRuntimeState(runtime: OwnedRuntime): Promise<PiLiveRuntimeState> {
    const state = await this.runtimeState(runtime)
    if (!runtime.suspended) return state
    return {
      ...state,
      status: 'initializing',
      initializationStage: 'starting_worker',
      initializationMessage: '正在恢复 Pi Runtime',
      initializationElapsedMs: 0,
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
    }
  }

  private async runtimeState(runtime: OwnedRuntime): Promise<PiLiveRuntimeState> {
    await this.refreshWorkspaceContext(runtime)
    if (runtime.status === 'initializing') runtime.initializationElapsedMs = Math.max(0, Date.now() - runtime.initializationStartedAt)
    if (runtime.status === 'ready' && runtime.handle) {
      const state = await runtime.handle.state()
      this.persistSessionIfChanged(runtime, state)
      this.updateRuntimeResources(runtime, state)
      this.persistStartupAuditBestEffort(runtime, state)
      this.persistPackageUpdatesBestEffort(runtime, runtime.generation)
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
      ...(runtime.packageUpdateCheck ? { packageUpdateCheck: runtime.packageUpdateCheck } : {}),
      ...(runtime.packageUpdates.length ? { packageUpdates: runtime.packageUpdates } : {}),
      ...(runtime.startupOutput.length ? { startupOutput: runtime.startupOutput } : {}),
      ...(runtime.capabilities ? { capabilities: runtime.capabilities } : {}),
      ...(runtime.error ? { error: runtime.error } : {}),
      ...(runtime.input.name ? { sessionName: runtime.input.name } : {}),
      ...(runtime.input.sessionPath ? { sessionFile: runtime.input.sessionPath } : {}),
      ...(runtime.taskSummary ? { taskSummary: runtime.taskSummary } : {}),
      ...((runtime.taskSummary || runtime.input.name) ? { title: runtime.taskSummary || runtime.input.name } : {}),
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
    const safeState = { ...state }
    delete safeState.startupResources
    delete safeState.packageUpdates
    delete safeState.packageUpdateCheck
    return {
      ...safeState,
      runtimeSessionId: runtime.id,
      startedAt: runtime.createdAt,
      status: 'ready',
      initializationStage: 'ready',
      initializationMessage: runtime.message,
      initializationElapsedMs: runtime.initializationElapsedMs,
      initializationTimings: runtime.initializationTimings,
      ...(runtime.startupResources ? { startupResources: runtime.startupResources } : {}),
      ...(runtime.packageUpdateCheck ? { packageUpdateCheck: runtime.packageUpdateCheck } : {}),
      ...(runtime.packageUpdates.length ? { packageUpdates: runtime.packageUpdates } : {}),
      ...(runtime.startupOutput.length ? { startupOutput: runtime.startupOutput } : {}),
      ...(runtime.capabilities ? { capabilities: runtime.capabilities } : {}),
      ...(runtime.taskSummary ? { taskSummary: runtime.taskSummary } : {}),
      ...((runtime.taskSummary || safeState.sessionName || runtime.input.name)
        ? { title: runtime.taskSummary || safeState.sessionName || runtime.input.name }
        : {}),
      workspacePath: runtime.workspacePath,
      projectName: runtime.projectName,
      ...(runtime.gitBranch ? { gitBranch: runtime.gitBranch } : {}),
      ...(runtime.handle?.processId ? { processId: runtime.handle.processId } : {}),
    }
  }

  private updateStartupAuditCandidate(runtime: OwnedRuntime, resources: PiLiveStartupResources): void {
    const attempt = `${runtime.generation}:${runtime.initializationStartedAt}`
    if (runtime.startupAuditCompleted === attempt || runtime.startupAuditPending === attempt) return
    runtime.startupAuditResources = copyStartupResources(resources)
    runtime.startupResourcesCapturedAt = new Date().toISOString()
  }

  private updateRuntimeResources(runtime: OwnedRuntime, state: PiLiveRuntimeState): void {
    const status = packageUpdateStatus(state.packageUpdateCheck)
    if (status) {
      runtime.packageUpdateCheck = status
      if (finalPackageUpdateStatus(status) && !runtime.packageUpdatesCheckedAt) {
        runtime.packageUpdatesCheckedAt = new Date().toISOString()
      }
    }
    if (state.packageUpdates !== undefined) runtime.packageUpdates = packageUpdates(state.packageUpdates)
    const resources = startupResources(state.startupResources)
    if (!resources) return
    runtime.startupResources = resources
    this.updateStartupAuditCandidate(runtime, resources)
  }

  private persistStartupAuditBestEffort(runtime: OwnedRuntime, state: PiLiveRuntimeState): void {
    if (!this.startupAudit || !runtime.startupAuditResources) return
    const nativeSessionId = state.nativeSessionId?.trim()
    if (!nativeSessionId) return

    const attempt = `${runtime.generation}:${runtime.initializationStartedAt}`
    if (runtime.startupAuditCompleted === attempt || runtime.startupAuditPending === attempt) return

    const capturedAt = runtime.startupResourcesCapturedAt ?? new Date().toISOString()
    const packageStatus = finalPackageUpdateStatus(runtime.packageUpdateCheck)
    const snapshot = {
      runtimeSessionId: runtime.id,
      attemptStartedAt: new Date(runtime.initializationStartedAt).toISOString(),
      attemptGeneration: runtime.generation,
      capturedAt,
      nativeSessionId,
      workspacePath: runtime.workspacePath,
      startupResources: copyStartupResources(runtime.startupAuditResources),
      ...(packageStatus ? { packageUpdateCheck: packageStatus } : {}),
      ...(packageStatus ? { packageUpdates: [...runtime.packageUpdates] } : {}),
      ...(packageStatus && runtime.packageUpdatesCheckedAt
        ? { packageUpdatesCheckedAt: runtime.packageUpdatesCheckedAt }
        : {}),
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
    task = this.startupAudit.recordStartupAudit(snapshot).then(() => {
      if (runtime.startupAuditPending === attempt) runtime.startupAuditCompleted = attempt
      if (packageStatus) runtime.startupPackageAuditCompleted = attempt
    }).catch(error => {
      console.warn('[AgentLens] Pi Live startup audit failed', error)
    }).finally(() => {
      if (runtime.startupAuditPending === attempt) runtime.startupAuditPending = undefined
      if (runtime.startupAuditTask === task) runtime.startupAuditTask = undefined
    })
    runtime.startupAuditTask = task
  }

  private persistPackageUpdatesBestEffort(runtime: OwnedRuntime, generation: number): void {
    const startupAudit = this.startupAudit
    const startupAuditResources = runtime.startupAuditResources
    if (!startupAudit || !startupAuditResources) return
    const packageStatus = finalPackageUpdateStatus(runtime.packageUpdateCheck)
    if (!packageStatus || runtime.status !== 'ready' || !runtime.handle) return

    const attempt = `${runtime.generation}:${runtime.initializationStartedAt}`
    if (runtime.startupPackageAuditCompleted === attempt || runtime.startupPackageAuditPending === attempt) return

    runtime.startupPackageAuditPending = attempt
    const handle = runtime.handle
    let task: Promise<void>
    task = (async () => {
      await runtime.startupAuditTask?.catch(() => undefined)
      if (runtime.startupPackageAuditCompleted === attempt) return
      if (runtime.generation !== generation || runtime.status !== 'ready' || runtime.handle !== handle) return
      const state = await handle.state()
      if (runtime.generation !== generation || runtime.status !== 'ready' || runtime.handle !== handle) return
      const nativeSessionId = state.nativeSessionId?.trim()
      if (!nativeSessionId) return

      const capturedAt = runtime.startupResourcesCapturedAt ?? new Date().toISOString()
      await startupAudit.recordStartupAudit({
        runtimeSessionId: runtime.id,
        attemptStartedAt: new Date(runtime.initializationStartedAt).toISOString(),
        attemptGeneration: runtime.generation,
        capturedAt,
        nativeSessionId,
        workspacePath: runtime.workspacePath,
        startupResources: copyStartupResources(startupAuditResources),
        packageUpdateCheck: packageStatus,
        packageUpdates: [...runtime.packageUpdates],
        ...(runtime.packageUpdatesCheckedAt ? { packageUpdatesCheckedAt: runtime.packageUpdatesCheckedAt } : {}),
        ...(runtime.input.executable ? { executable: runtime.input.executable } : {}),
        ...(state.sdkVersion ?? runtime.capabilities?.sdkVersion
          ? { sdkVersion: state.sdkVersion ?? runtime.capabilities?.sdkVersion }
          : {}),
        ...(state.sessionName ?? runtime.input.name
          ? { sessionName: state.sessionName ?? runtime.input.name }
          : {}),
      })
      if (runtime.startupPackageAuditPending === attempt) runtime.startupPackageAuditCompleted = attempt
    })().catch(error => {
      console.warn('[AgentLens] Pi Live package update audit failed', error)
    }).finally(() => {
      if (runtime.startupPackageAuditPending === attempt) runtime.startupPackageAuditPending = undefined
      if (runtime.startupPackageAuditTask === task) runtime.startupPackageAuditTask = undefined
    })
    runtime.startupPackageAuditTask = task
  }

  private captureTaskSummary(runtime: OwnedRuntime, message: string): void {
    if (runtime.taskSummary || runtime.input.name?.trim()) return
    const summary = taskSummary(message)
    if (!summary) return
    runtime.taskSummary = summary
    this.publish(runtime, { type: 'task_summary', taskSummary: summary })
    this.persistRuntimeMetadataBestEffort(runtime)
  }

  private publish(runtime: OwnedRuntime, event: Record<string, unknown>): void {
    const type = typeof event.type === 'string' ? event.type : ''
    const message = event.message && typeof event.message === 'object' && !Array.isArray(event.message)
      ? event.message as Record<string, unknown>
      : undefined
    const messageRole = typeof message?.role === 'string' ? message.role : ''
    const messageId = typeof message?.id === 'string' ? message.id : ''
    runtime.lastActiveAt = Date.now()

    if (type === 'message_start' && messageRole === 'assistant') {
      runtime.activeAssistantMessageId = messageId || undefined
    }
    if (type === 'extension_ui_request') {
      const requestId = typeof event.id === 'string'
        ? event.id
        : typeof event.requestId === 'string'
          ? event.requestId
          : ''
      if (requestId) runtime.pendingExtensionRequestIds.add(requestId)
    }

    const publishedEvent = type === 'message_update' && runtime.activeAssistantMessageId
      ? { ...event, messageId: runtime.activeAssistantMessageId }
      : event

    if (type === 'queue_update') {
      runtime.queue = {
        steering: queueMessages(event.steering),
        followUp: queueMessages(event.followUp),
      }
    }
    runtime.events.publish(publishedEvent)

    const settled = (type === 'message_end' && messageRole === 'assistant')
      || type === 'agent_settled'
      || type === 'agent_end'
      || type === 'runtime_exit'
    if (settled) {
      runtime.activeAssistantMessageId = undefined
      if (type === 'agent_settled' || type === 'agent_end' || type === 'runtime_exit') {
        runtime.pendingExtensionRequestIds.clear()
      }
      if (runtime.subscriberCount === 0) this.scheduleIdleCheck(runtime)
    }
  }
}
