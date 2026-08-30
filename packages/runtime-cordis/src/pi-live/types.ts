export type PiLiveStreamingBehavior = 'steer' | 'followUp'

export interface PiLiveStartInput {
  cwd: string
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
  nativeSessionId?: string | undefined
  sessionFile?: string | undefined
  sessionName?: string | undefined
  model?: unknown
  thinkingLevel?: string | undefined
  isStreaming: boolean
  isCompacting: boolean
  pendingMessageCount: number
  leafId?: string | null | undefined
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
  /** Terminate the owned Pi process. This is intentionally different from aborting one task run. */
  terminate(runtimeSessionId: string): Promise<void>
  dispose(): Promise<void>
}
