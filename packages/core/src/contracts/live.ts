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
  | 'command-discovery'
  | 'workspace-file-reference'
  | 'recovery'

export type LiveInputSupport = 'native' | 'transform' | 'unsupported'
export type LiveStartFieldSupport = 'required' | 'optional' | 'unsupported'

export const LIVE_ATTACHMENT_MAX_ITEM_BYTES = 12 * 1024 * 1024

export interface LiveInputCapabilities {
  text: LiveInputSupport
  largeText: LiveInputSupport
  image: LiveInputSupport
  file: LiveInputSupport
  multiline: LiveInputSupport
}

/** Agent-neutral task creation input. Adapters translate this into native start arguments. */
export interface LiveStartInput {
  workspacePath?: string | undefined
  title?: string | undefined
}

export interface LiveStartCapabilities {
  workspace: LiveStartFieldSupport
  title: LiveStartFieldSupport
}

export interface LiveTextPart {
  type: 'text'
  text: string
}

export interface LiveLargeTextPart {
  type: 'large-text'
  text: string
  lineCount?: number | undefined
  charCount?: number | undefined
}

export interface LiveAttachmentDescriptor {
  attachmentId: string
  name?: string | undefined
  mimeType?: string | undefined
  sizeBytes: number
}

export interface LiveAttachment extends LiveAttachmentDescriptor {
  data: Uint8Array
}

export interface PutLiveAttachmentInput {
  attachmentId?: string | undefined
  data: Uint8Array
  name?: string | undefined
  mimeType?: string | undefined
}

export interface LiveAttachmentService {
  put(input: PutLiveAttachmentInput): Promise<LiveAttachmentDescriptor>
  get(attachmentId: string): Promise<LiveAttachment | null>
  remove(attachmentId: string): Promise<void>
  dispose(): Promise<void>
}

export interface LiveAttachmentPartBase {
  /**
   * AgentLens-owned opaque attachment reference. Adapters may resolve or
   * transform it, but must not expose native temporary paths as the contract.
   */
  attachmentId: string
  name?: string | undefined
  mimeType?: string | undefined
  sizeBytes?: number | undefined
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

export type LiveEventStatus =
  | 'initializing'
  | 'ready'
  | 'running'
  | 'idle'
  | 'compacting'
  | 'failed'
  | 'terminating'
  | 'terminated'

export type LiveCompletionStatus = 'completed' | 'cancelled' | 'interrupted' | 'failed'

export interface LiveStatusEvent {
  type: 'status'
  status: LiveEventStatus
  message?: string | undefined
}

export interface LiveMessageBoundaryEvent {
  type: 'message.start' | 'message.end'
  role?: 'user' | 'assistant' | 'tool' | 'system' | 'unknown' | undefined
  messageId?: string | undefined
}

export interface LiveContentEvent {
  type:
    | 'text.start'
    | 'text.delta'
    | 'text.end'
    | 'reasoning.start'
    | 'reasoning.delta'
    | 'reasoning.end'
  text?: string | undefined
  delta?: string | undefined
  messageId?: string | undefined
  contentIndex?: number | undefined
}

export interface LiveToolStartEvent {
  type: 'tool.start'
  callId?: string | undefined
  name: string
  inputPreview?: string | undefined
  contentIndex?: number | undefined
}

export interface LiveToolOutputEvent {
  type: 'tool.output'
  callId?: string | undefined
  name?: string | undefined
  output: string
}

export interface LiveToolEndEvent {
  type: 'tool.end'
  callId?: string | undefined
  name?: string | undefined
  status: 'success' | 'error'
  output?: string | undefined
  durationMs?: number | undefined
}

export interface LiveErrorEvent {
  type: 'error'
  message: string
}

export interface LiveCompletedEvent {
  type: 'completed'
  status: LiveCompletionStatus
  message?: string | undefined
}

export interface LiveQueueUpdateEvent {
  type: 'queue.update'
  steering: readonly string[]
  followUp: readonly string[]
}

export type LiveUiRequestMethod = 'select' | 'confirm' | 'input' | 'editor'

export interface LiveUiRequestEvent {
  type: 'ui.request'
  requestId: string
  method: LiveUiRequestMethod
  title?: string | undefined
  message?: string | undefined
  options?: readonly string[] | undefined
  placeholder?: string | undefined
  prefill?: string | undefined
}

export type LiveEvent =
  | LiveStatusEvent
  | LiveMessageBoundaryEvent
  | LiveContentEvent
  | LiveToolStartEvent
  | LiveToolOutputEvent
  | LiveToolEndEvent
  | LiveQueueUpdateEvent
  | LiveUiRequestEvent
  | LiveErrorEvent
  | LiveCompletedEvent

export interface LiveRuntimeEvent {
  runtimeSessionId: string
  sequence: number
  receivedAt: string
  /** Native event retained for diagnostics and Agent-specific compatibility UI. */
  event: Readonly<Record<string, unknown>>
  /** Agent-neutral event consumed by the shared Live renderer when this native event has stable common semantics. */
  normalizedEvent?: Readonly<LiveEvent> | undefined
}

export interface LiveSendOptions {
  behavior?: 'normal' | 'steer' | 'follow-up'
}

export interface LiveQueueState {
  steering: readonly string[]
  followUp: readonly string[]
}

export interface LiveInterruptResult {
  restoredQueue?: LiveQueueState | undefined
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

export interface LiveCommand extends LiveControlDisplayInfo {
  /** Runtime-owned text inserted into the composer, e.g. "/skill:review". */
  value: string
  /** Optional runtime-owned grouping key such as extension / prompt / skill. */
  group?: string | undefined
}

export interface LiveWorkspaceFileReference {
  /** Runtime-owned text inserted in place of the active file-reference token. */
  insertText: string
  /** Caret offset relative to insertText after insertion. */
  cursorOffset: number
}

export interface LiveThinkingControl extends LiveControlDisplayInfo {
  capability: 'thinking-control'
  /** Current effective Runtime value. */
  value: string
  /** Runtime-provided options in Runtime order. */
  options: readonly LiveControlOption[]
}

export interface LiveModelControl extends LiveControlDisplayInfo {
  capability: 'model-switching'
  /** Current Runtime-owned opaque value when known. */
  value?: string | undefined
  /** Runtime-provided model options in Runtime order. */
  options: readonly LiveControlOption[]
}

function liveControlRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function validLiveControlOptions(value: unknown): value is readonly LiveControlOption[] {
  if (!Array.isArray(value) || value.length === 0) return false
  for (const candidate of value) {
    const option = liveControlRecord(candidate)
    if (!option || typeof option.value !== 'string' || !option.value) return false
    if (option.label !== undefined && typeof option.label !== 'string') return false
    if (option.description !== undefined && typeof option.description !== 'string') return false
  }
  return true
}

export function isLiveThinkingControl(value: unknown): value is LiveThinkingControl {
  const control = liveControlRecord(value)
  if (!control || control.capability !== 'thinking-control') return false
  if (typeof control.value !== 'string' || !control.value) return false
  if (control.label !== undefined && typeof control.label !== 'string') return false
  if (control.description !== undefined && typeof control.description !== 'string') return false
  if (!validLiveControlOptions(control.options)) return false
  return control.options.some(option => option.value === control.value)
}

export function isLiveModelControl(value: unknown): value is LiveModelControl {
  const control = liveControlRecord(value)
  if (!control || control.capability !== 'model-switching') return false
  if (control.value !== undefined && (typeof control.value !== 'string' || !control.value)) return false
  if (control.label !== undefined && typeof control.label !== 'string') return false
  if (control.description !== undefined && typeof control.description !== 'string') return false
  if (!validLiveControlOptions(control.options)) return false
  return control.value === undefined || control.options.some(option => option.value === control.value)
}

export interface LiveAdapter {
  readonly manifest: LiveAdapterManifest
  readonly capabilities: ReadonlySet<LiveCapabilityName>
  readonly inputCapabilities: Readonly<LiveInputCapabilities>
  /** Optional during migration; omitted means no structured Product-Surface start fields are advertised. */
  readonly startCapabilities?: Readonly<LiveStartCapabilities>

  availability(): Promise<LiveAvailability>
  list(): Promise<LiveRuntimeState[]>
  start(input: unknown): Promise<LiveRuntimeState>
  /** Present only when the adapter declares resume. Logical session ids stay AgentLens-owned. */
  resume?(logicalSessionId: string): Promise<LiveRuntimeState>
  /** Present only when the adapter declares fork. Logical session ids stay AgentLens-owned. */
  fork?(logicalSessionId: string): Promise<LiveRuntimeState>
  state(runtimeSessionId: string): Promise<LiveRuntimeState>
  snapshot(runtimeSessionId: string, since?: string): Promise<LiveSnapshot>
  /** Present only when the adapter declares model-switching. */
  modelControl?(runtimeSessionId: string): Promise<LiveModelControl | null>
  /** Runtime-owned setter; value must be one returned by modelControl(). */
  setModelControl?(runtimeSessionId: string, value: string): Promise<LiveRuntimeState>
  /** Present only when the adapter declares thinking-control. */
  thinkingControl?(runtimeSessionId: string): Promise<LiveThinkingControl | null>
  /** Runtime-owned setter; value must be one returned by thinkingControl(). */
  setThinkingControl?(runtimeSessionId: string, value: string): Promise<LiveRuntimeState>
  /** Present only when the adapter declares extension-ui. */
  respondToExtension?(runtimeSessionId: string, requestId: string, response: unknown): Promise<void>
  /** Present only when the adapter declares command-discovery. */
  commands?(runtimeSessionId: string): Promise<readonly LiveCommand[]>
  /** Present only when the adapter declares workspace-file-reference. */
  workspaceFileReference?(
    runtimeSessionId: string,
    relativePath: string,
    isDirectory: boolean,
  ): Promise<LiveWorkspaceFileReference>
  send(runtimeSessionId: string, message: LiveMessageInput, options?: LiveSendOptions): Promise<void>
  subscribe(runtimeSessionId: string, listener: (event: LiveRuntimeEvent) => void): () => void
  /** Present only when the adapter declares queue. Returns the current queued messages without mutation. */
  queueState?(runtimeSessionId: string): Promise<LiveQueueState>
  /** Present only when the adapter declares queue. Clears and returns the current queued messages. */
  clearQueue?(runtimeSessionId: string): Promise<LiveQueueState>
  interrupt?(runtimeSessionId: string): Promise<LiveInterruptResult>
  terminate(runtimeSessionId: string): Promise<void>
  dispose(): Promise<void>
}

export interface LiveService {
  register(adapter: LiveAdapter): Disposable
  list(): LiveAdapter[]
  get(liveId: string): LiveAdapter | null
}
