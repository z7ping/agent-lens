import type { AgentProductId, Disposable } from '../domain/common'
import type { AgentLensPluginManifest } from './plugin'

export type LiveCapabilityName =
  | 'create'
  | 'resume'
  | 'fork'
  | 'send'
  | 'stream'
  | 'interrupt'
  | 'queue'
  | 'steer'
  | 'model-switching'
  | 'thinking-control'
  | 'extension-ui'
  | 'recovery'

export interface LiveAdapterManifest extends AgentLensPluginManifest {
  pluginType: 'live'
  liveId: string
  productId: AgentProductId
}

export interface LiveAvailability {
  available: boolean
  reason?: string
}

export type LiveRuntimeStatus =
  | 'initializing'
  | 'ready'
  | 'failed'
  | 'terminating'
  | 'terminated'

export interface LiveRuntimeState {
  runtimeSessionId: string
  status: LiveRuntimeStatus
  nativeSessionId?: string
  workspacePath?: string
  isStreaming: boolean
  pendingMessageCount: number
}

export interface LiveSnapshot {
  state: LiveRuntimeState
  entries: unknown[]
  leafId?: string | null
}

export interface LiveRuntimeEvent {
  runtimeSessionId: string
  sequence: number
  receivedAt: string
  event: Readonly<Record<string, unknown>>
}

export interface LiveSendOptions {
  behavior?: 'normal' | 'steer' | 'follow-up'
}

export interface LiveAdapter {
  readonly manifest: LiveAdapterManifest
  readonly capabilities: ReadonlySet<LiveCapabilityName>

  availability(): Promise<LiveAvailability>
  list(): Promise<LiveRuntimeState[]>
  start(input: unknown): Promise<LiveRuntimeState>
  state(runtimeSessionId: string): Promise<LiveRuntimeState>
  snapshot(runtimeSessionId: string, since?: string): Promise<LiveSnapshot>
  send(runtimeSessionId: string, message: string, options?: LiveSendOptions): Promise<void>
  subscribe(runtimeSessionId: string, listener: (event: LiveRuntimeEvent) => void): () => void
  interrupt?(runtimeSessionId: string): Promise<unknown>
  terminate(runtimeSessionId: string): Promise<void>
  dispose(): Promise<void>
}

export interface LiveService {
  register(adapter: LiveAdapter): Disposable
  list(): LiveAdapter[]
  get(liveId: string): LiveAdapter | null
}
