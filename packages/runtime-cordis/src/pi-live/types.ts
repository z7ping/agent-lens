export type PiLiveStreamingBehavior = 'steer' | 'followUp'
export type PiLiveRuntimeStatus = 'initializing' | 'ready' | 'failed' | 'terminating' | 'terminated'
export type PiLiveInitializationStage = 'starting_worker' | 'loading_sdk' | 'loading_resources' | 'creating_session' | 'binding_extensions' | 'ready'
export type PiLiveHistoryAction = 'continue' | 'fork'

export interface PiLiveInitializationTiming {
  stage: PiLiveInitializationStage
  durationMs: number
}

export interface PiLiveStartupResources {
  contexts: string[]
  skills: string[]
  prompts: string[]
  extensions: string[]
  themes: string[]
  diagnostics: string[]
}

export interface PiLiveRuntimeCapabilities {
  protocolVersion: number
  sdkVersion?: string | undefined
  sessionRuntime: boolean
  modelSwitching: boolean
  thinkingLevelControl: boolean
  extensionUi: boolean
}

export interface PiLiveStartInput {
  cwd: string
  /** Optional installed Pi CLI path used only to locate the matching official SDK package. */
  executable?: string | undefined
  provider?: string | undefined
  model?: string | undefined
  name?: string | undefined
  sessionDir?: string | undefined
  sessionPath?: string | undefined
  /** Internal-only action for a server-resolved Pi history JSONL. Never accepted from the generic public start endpoint. */
  historyAction?: PiLiveHistoryAction | undefined
}

export interface PiLiveAvailability {
  available: boolean
  executable?: string | undefined
  reason?: string | undefined
}

export interface PiLiveModelOption {
  provider: string
  id: string
  name?: string | undefined
  reasoning?: boolean | undefined
}

export interface PiLiveControls {
  models: PiLiveModelOption[]
  thinkingLevels: string[]
}

export interface PiLiveRuntimeState {
  /** Stable Pi Live task identity. A new Worker/PID may be attached after an AgentLens Daemon restart. */
  runtimeSessionId: string
  /** Durable AgentLens Live Task creation time; preserved across Daemon recovery. */
  startedAt?: string | undefined
  status: PiLiveRuntimeStatus
  initializationStage?: PiLiveInitializationStage | undefined
  initializationMessage?: string | undefined
  initializationElapsedMs?: number | undefined
  initializationTimings?: PiLiveInitializationTiming[] | undefined
  startupResources?: PiLiveStartupResources | undefined
  startupOutput?: string[] | undefined
  capabilities?: PiLiveRuntimeCapabilities | undefined
  error?: string | undefined
  sdkVersion?: string | undefined
  runtimeMode?: 'session_runtime' | 'compatibility' | undefined
  nativeSessionId?: string | undefined
  sessionFile?: string | undefined
  sessionName?: string | undefined
  /** 首条用户任务的简要文本，用于在列表中识别 Pi Live 会话。 */
  taskSummary?: string | undefined
  /** Public working-directory context. Native Pi session-file paths remain private. */
  workspacePath?: string | undefined
  projectName?: string | undefined
  gitBranch?: string | undefined
  model?: unknown
  thinkingLevel?: string | undefined
  isStreaming: boolean
  isCompacting: boolean
  pendingMessageCount: number
  leafId?: string | null | undefined
  /** Current Worker generation PID; unlike runtimeSessionId this is intentionally not durable. */
  processId?: number | undefined
}

export interface PiLiveSnapshot {
  state: PiLiveRuntimeState
  entries: unknown[]
  leafId: string | null
}

export interface PiLiveQueueState {
  steering: string[]
  followUp: string[]
}

export interface PiLiveRuntimeEvent {
  runtimeSessionId: string
  sequence: number
  receivedAt: string
  event: Record<string, unknown>
}

export type PiLiveRuntimeListener = (event: PiLiveRuntimeEvent) => void

export interface PiLiveService {
  availability(): Promise<PiLiveAvailability>
  /** List live tasks owned now or restored from the previous AgentLens Daemon generation. */
  list(): Promise<PiLiveRuntimeState[]>
  start(input: PiLiveStartInput): Promise<PiLiveRuntimeState>
  retry(runtimeSessionId: string): Promise<PiLiveRuntimeState>
  state(runtimeSessionId: string): Promise<PiLiveRuntimeState>
  snapshot(runtimeSessionId: string, since?: string): Promise<PiLiveSnapshot>
  controls(runtimeSessionId: string): Promise<PiLiveControls>
  setModel(runtimeSessionId: string, provider: string, modelId: string): Promise<PiLiveRuntimeState>
  setThinkingLevel(runtimeSessionId: string, level: string): Promise<PiLiveRuntimeState>
  prompt(runtimeSessionId: string, message: string, behavior?: PiLiveStreamingBehavior): Promise<void>
  steer(runtimeSessionId: string, message: string): Promise<void>
  followUp(runtimeSessionId: string, message: string): Promise<void>
  clearQueue(runtimeSessionId: string): Promise<PiLiveQueueState>
  abort(runtimeSessionId: string, options?: { restoreQueue?: boolean }): Promise<PiLiveQueueState>
  respondToExtension(runtimeSessionId: string, requestId: string, response: unknown): Promise<void>
  subscribe(runtimeSessionId: string, listener: PiLiveRuntimeListener): () => void
  /** Explicit user termination removes the durable recovery record; this differs from Daemon disposal. */
  terminate(runtimeSessionId: string): Promise<void>
  /** Stop current Worker generations while preserving recoverable live tasks for the next Daemon generation. */
  dispose(): Promise<void>
}
