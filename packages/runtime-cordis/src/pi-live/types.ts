export type PiLiveStreamingBehavior = 'steer' | 'followUp'

export interface PiLiveStartInput {
  cwd: string
  executable?: string
  provider?: string
  model?: string
  name?: string
  sessionDir?: string
  sessionPath?: string
}

export interface PiLiveAvailability {
  available: boolean
  executable?: string
  reason?: string
}

export interface PiLiveRuntimeState {
  runtimeSessionId: string
  nativeSessionId?: string
  sessionFile?: string
  sessionName?: string
  model?: unknown
  thinkingLevel?: string
  isStreaming: boolean
  isCompacting: boolean
  pendingMessageCount: number
  leafId?: string | null
  processId?: number
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
  list(): Promise<PiLiveRuntimeState[]>
  start(input: PiLiveStartInput): Promise<PiLiveRuntimeState>
  state(runtimeSessionId: string): Promise<PiLiveRuntimeState>
  snapshot(runtimeSessionId: string, since?: string): Promise<PiLiveSnapshot>
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
