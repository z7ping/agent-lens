export type PiLiveStreamingBehavior = 'steer' | 'followUp'
export type PiLiveRuntimeStatus = 'initializing' | 'ready' | 'failed' | 'terminating' | 'terminated'
export type PiLiveInitializationStage = 'starting_worker' | 'loading_sdk' | 'loading_resources' | 'creating_session' | 'binding_extensions' | 'ready'

export interface PiLiveInitializationTiming {
  stage: PiLiveInitializationStage
  durationMs: number
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
  runtimeSessionId: string
  status: PiLiveRuntimeStatus
  initializationStage?: PiLiveInitializationStage | undefined
  initializationMessage?: string | undefined
  initializationElapsedMs?: number | undefined
  initializationTimings?: PiLiveInitializationTiming[] | undefined
  capabilities?: PiLiveRuntimeCapabilities | undefined
  error?: string | undefined
  sdkVersion?: string | undefined
  runtimeMode?: 'session_runtime' | 'compatibility' | undefined
  nativeSessionId?: string | undefined
  sessionFile?: string | undefined
  sessionName?: string | undefined
  model?: unknown
  thinkingLevel?: string | undefined
  isStreaming: boolean
  isCompacting: boolean
  pendingMessageCount: number
  leafId?: string | null | undefined
  /** Legacy transport compatibility. Worker-backed Pi runtimes expose the Worker PID here. */
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
  /** List Pi runtimes currently owned by this AgentLens runtime generation. */
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
  /** Dispose the owned Pi Runtime Worker. This is intentionally different from aborting one task run. */
  terminate(runtimeSessionId: string): Promise<void>
  dispose(): Promise<void>
}
