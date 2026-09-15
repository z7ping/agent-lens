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

export type LiveInputSupport = 'native' | 'transform' | 'unsupported'

export interface LiveInputCapabilities {
  text: LiveInputSupport
  largeText: LiveInputSupport
  image: LiveInputSupport
  file: LiveInputSupport
  multiline: LiveInputSupport
}

export interface LiveTextPart {
  type: 'text'
  text: string
}

export interface LiveLargeTextPart {
  type: 'large-text'
  text: string
  lineCount?: number
  charCount?: number
}

export interface LiveAttachmentPartBase {
  /**
   * AgentLens-owned opaque attachment reference. Adapters may resolve or
   * transform it, but must not expose native temporary paths as the contract.
   */
  attachmentId: string
  name?: string
  mimeType?: string
  sizeBytes?: number
}

export interface LiveImagePart extends LiveAttachmentPartBase {
  type: 'image'
}

export interface LiveFilePart extends LiveAttachmentPartBase {
  type: 'file'
}

export type LiveMessagePart =
  | LiveTextPart
  | LiveLargeTextPart
  | LiveImagePart
  | LiveFilePart

export interface LiveMessage {
  parts: readonly LiveMessagePart[]
}

/**
 * String remains a compatibility input while existing Pi/Hermes surfaces
 * migrate. Adapters receive a normalized LiveMessage through live-support.
 */
export type LiveMessageInput = string | LiveMessage

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

export interface LiveControlDisplayInfo {
  label?: string
  description?: string
}

export interface LiveControlOption extends LiveControlDisplayInfo {
  /**
   * Runtime-owned opaque value. AgentLens must round-trip it unchanged and
   * must not merge vendor-specific values by guessed semantics.
   */
  value: string
}

export interface LiveThinkingControl extends LiveControlDisplayInfo {
  capability: 'thinking-control'
  /** Current effective Runtime value. */
  value: string
  /** Runtime-provided options in Runtime order. */
  options: readonly LiveControlOption[]
}

function liveControlRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function isLiveThinkingControl(value: unknown): value is LiveThinkingControl {
  const control = liveControlRecord(value)
  if (!control || control.capability !== 'thinking-control') return false
  if (typeof control.value !== 'string' || !control.value) return false
  if (control.label !== undefined && typeof control.label !== 'string') return false
  if (control.description !== undefined && typeof control.description !== 'string') return false
  if (!Array.isArray(control.options) || control.options.length === 0) return false

  let hasCurrent = false
  for (const candidate of control.options) {
    const option = liveControlRecord(candidate)
    if (!option || typeof option.value !== 'string' || !option.value) return false
    if (option.label !== undefined && typeof option.label !== 'string') return false
    if (option.description !== undefined && typeof option.description !== 'string') return false
    if (option.value === control.value) hasCurrent = true
  }
  return hasCurrent
}

export interface LiveAdapter {
  readonly manifest: LiveAdapterManifest
  readonly capabilities: ReadonlySet<LiveCapabilityName>
  readonly inputCapabilities: Readonly<LiveInputCapabilities>

  availability(): Promise<LiveAvailability>
  list(): Promise<LiveRuntimeState[]>
  start(input: unknown): Promise<LiveRuntimeState>
  state(runtimeSessionId: string): Promise<LiveRuntimeState>
  snapshot(runtimeSessionId: string, since?: string): Promise<LiveSnapshot>
  /** Present only when the adapter declares thinking-control. */
  thinkingControl?(runtimeSessionId: string): Promise<LiveThinkingControl | null>
  /** Runtime-owned setter; value must be one returned by thinkingControl(). */
  setThinkingControl?(runtimeSessionId: string, value: string): Promise<LiveRuntimeState>
  send(runtimeSessionId: string, message: LiveMessageInput, options?: LiveSendOptions): Promise<void>
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
