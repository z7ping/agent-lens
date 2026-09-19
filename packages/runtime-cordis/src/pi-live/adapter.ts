import { Buffer } from 'node:buffer'
import { isLiveModelControl, isLiveThinkingControl } from '@agent-lens/core'
import type {
  LiveAdapter,
  LiveAdapterManifest,
  LiveAttachmentService,
  LiveCapabilityName,
  LiveCommand,
  LiveEvent,
  LiveHistoryIndexQuery,
  LiveMessage,
  LiveMessageInput,
  LiveModelControl,
  LiveRuntimeEvent,
  LiveSendOptions,
  LiveSnapshotWindow,
  StorageService,
} from '@agent-lens/core'
import {
  createLiveCapabilitySet,
  createLiveInputCapabilities,
  dispatchLiveSend,
  requireLiveMessageSupport,
} from '@agent-lens/live-support'
import { canonicalPiLiveSnapshot, isCanonicalHistoryCursor } from './canonical-history'
import { resolvePiLiveHistoryInput } from './history-interaction'
import type {
  PiLiveImageInput,
  PiLiveRuntimeState,
  PiLiveService,
  PiLiveSnapshot,
  PiLiveStartInput,
} from './types'

const CAPABILITIES = [
  'create',
  'resume',
  'fork',
  'send',
  'stream',
  'interrupt',
  'queue',
  'steer',
  'model-switching',
  'thinking-control',
  'extension-ui',
  'command-discovery',
  'workspace-file-reference',
  'history-index',
  'recovery',
] as const satisfies readonly LiveCapabilityName[]

const INPUT_CAPABILITIES = createLiveInputCapabilities({
  text: 'native',
  largeText: 'transform',
  image: 'native',
  file: 'unsupported',
  multiline: 'native',
})

export const piLiveAdapterManifest: LiveAdapterManifest = {
  pluginId: '@agent-lens/runtime-cordis/pi-live',
  pluginVersion: '1.0.0-alpha.5',
  apiVersion: '1.0',
  pluginType: 'live',
  displayName: 'Pi Live',
  liveId: 'pi',
  productId: 'pi',
  capabilities: [...CAPABILITIES],
}

function piStartInput(value: unknown): PiLiveStartInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Pi Live start input must be an object')
  }
  const input = value as Partial<PiLiveStartInput> & {
    workspacePath?: unknown
    title?: unknown
  }
  const cwd = typeof input.workspacePath === 'string' && input.workspacePath.trim()
    ? input.workspacePath.trim()
    : typeof input.cwd === 'string' && input.cwd.trim()
      ? input.cwd.trim()
      : ''
  if (!cwd) throw new TypeError('Pi Live start input requires workspacePath')
  const title = typeof input.title === 'string' && input.title.trim()
    ? input.title.trim()
    : typeof input.name === 'string' && input.name.trim()
      ? input.name.trim()
      : undefined
  return {
    cwd,
    ...(typeof input.executable === 'string' ? { executable: input.executable } : {}),
    ...(typeof input.provider === 'string' ? { provider: input.provider } : {}),
    ...(typeof input.model === 'string' ? { model: input.model } : {}),
    ...(title ? { name: title } : {}),
    ...(typeof input.sessionDir === 'string' ? { sessionDir: input.sessionDir } : {}),
    ...(typeof input.sessionPath === 'string' ? { sessionPath: input.sessionPath } : {}),
    ...(input.historyAction === 'continue' || input.historyAction === 'fork'
      ? { historyAction: input.historyAction }
      : {}),
  }
}

function liveRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function liveText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function livePreview(value: unknown, max = 4_000): string {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string'
    ? value
    : (() => {
        try { return JSON.stringify(value) } catch { return String(value) }
      })()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function liveContentIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function piMessageUpdateEvent(event: Record<string, unknown>): LiveEvent | undefined {
  const update = liveRecord(event.assistantMessageEvent)
  const type = liveText(update.type)
  const contentIndex = liveContentIndex(update.contentIndex)
  const partial = liveRecord(update.partial)
  const content = Array.isArray(partial.content) ? partial.content : []
  const block = contentIndex === undefined ? {} : liveRecord(content[contentIndex])
  const messageId = liveText(event.messageId)
  const common = {
    ...(contentIndex === undefined ? {} : { contentIndex }),
    ...(messageId ? { messageId } : {}),
  }

  if (type === 'text_start') {
    return { type: 'text.start', text: liveText(block.text), ...common }
  }
  if (type === 'text_delta') {
    const delta = liveText(update.delta)
    return delta ? { type: 'text.delta', delta, ...common } : undefined
  }
  if (type === 'text_end') {
    return { type: 'text.end', text: liveText(update.content) || liveText(block.text), ...common }
  }
  if (type === 'thinking_start') {
    return {
      type: 'reasoning.start',
      text: liveText(block.thinking) || liveText(block.text),
      ...common,
    }
  }
  if (type === 'thinking_delta') {
    const delta = liveText(update.delta)
    return delta ? { type: 'reasoning.delta', delta, ...common } : undefined
  }
  if (type === 'thinking_end') {
    return {
      type: 'reasoning.end',
      text: liveText(update.content) || liveText(block.thinking) || liveText(block.text),
      ...common,
    }
  }
  return undefined
}

/**
 * Maps Pi-native runtime events to the Agent-neutral Live event vocabulary.
 * Unmapped Pi events remain available through event.event for diagnostics and
 * Pi-only compatibility UI, but shared renderers must consume normalizedEvent.
 */
export function normalizePiLiveEvent(event: Readonly<Record<string, unknown>>): LiveEvent | undefined {
  const type = liveText(event.type)
  if (type === 'agent_start') return { type: 'status', status: 'running' }
  if (type === 'task_summary') {
    const title = liveText(event.taskSummary).trim()
    return title ? { type: 'title.update', title } : undefined
  }
  if (type === 'model_changed') return { type: 'control.changed', control: 'model' }
  if (type === 'thinking_level_changed') return { type: 'control.changed', control: 'thinking' }
  if (type === 'runtime_resources'
    || type === 'package_updates'
    || type === 'runtime_extension_binding') {
    return { type: 'runtime-disclosure.changed' }
  }
  if (type === 'agent_settled' || type === 'agent_end') {
    return { type: 'completed', status: 'completed' }
  }
  if (type === 'message_start' || type === 'message_end') {
    const message = liveRecord(event.message)
    const rawRole = liveText(message.role)
    const role = rawRole === 'user' || rawRole === 'assistant' || rawRole === 'tool' || rawRole === 'system'
      ? rawRole
      : 'unknown'
    const messageId = liveText(message.id)
    return {
      type: type === 'message_start' ? 'message.start' : 'message.end',
      role,
      ...(messageId ? { messageId } : {}),
    }
  }
  if (type === 'message_update') return piMessageUpdateEvent(event)
  if (type === 'tool_execution_start') {
    const callId = liveText(event.toolCallId)
    return {
      type: 'tool.start',
      ...(callId ? { callId } : {}),
      name: liveText(event.toolName) || 'tool',
      ...(event.args === undefined ? {} : { inputPreview: livePreview(event.args) }),
    }
  }
  if (type === 'tool_execution_update') {
    const callId = liveText(event.toolCallId)
    const output = livePreview(event.partialResult)
    if (!output) return undefined
    return {
      type: 'tool.output',
      ...(callId ? { callId } : {}),
      ...(liveText(event.toolName) ? { name: liveText(event.toolName) } : {}),
      output,
    }
  }
  if (type === 'tool_execution_end') {
    const callId = liveText(event.toolCallId)
    const output = livePreview(event.result)
    return {
      type: 'tool.end',
      ...(callId ? { callId } : {}),
      ...(liveText(event.toolName) ? { name: liveText(event.toolName) } : {}),
      status: event.isError === true ? 'error' : 'success',
      ...(output ? { output } : {}),
    }
  }
  if (type === 'compaction_start') return { type: 'status', status: 'compacting' }
  if (type === 'compaction_end') return { type: 'status', status: 'ready' }
  if (type === 'runtime_initialization') {
    const stage = liveText(event.stage)
    return {
      type: 'status',
      status: stage === 'ready' ? 'ready' : 'initializing',
      ...(liveText(event.message) ? { message: liveText(event.message) } : {}),
    }
  }
  if (type === 'runtime_status') {
    const status = liveText(event.status)
    if (status === 'initializing' || status === 'ready' || status === 'failed'
      || status === 'terminating' || status === 'terminated') {
      return {
        type: 'status',
        status,
        ...(liveText(event.message) ? { message: liveText(event.message) } : {}),
      }
    }
  }
  if (type === 'queue_update') {
    const steering = Array.isArray(event.steering)
      ? event.steering.filter((item): item is string => typeof item === 'string')
      : []
    const followUp = Array.isArray(event.followUp)
      ? event.followUp.filter((item): item is string => typeof item === 'string')
      : []
    return { type: 'queue.update', steering, followUp }
  }
  if (type === 'extension_ui_request') {
    const requestId = liveText(event.id)
    const method = liveText(event.method)
    if (!requestId || (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor')) {
      return undefined
    }
    const options = Array.isArray(event.options)
      ? event.options.filter((item): item is string => typeof item === 'string')
      : undefined
    return {
      type: 'ui.request',
      requestId,
      method,
      ...(liveText(event.title) ? { title: liveText(event.title) } : {}),
      ...(liveText(event.message) ? { message: liveText(event.message) } : {}),
      ...(options ? { options } : {}),
      ...(liveText(event.placeholder) ? { placeholder: liveText(event.placeholder) } : {}),
      ...(liveText(event.prefill) ? { prefill: liveText(event.prefill) } : {}),
    }
  }
  if (type === 'runtime_exit') {
    const message = liveText(event.errorMessage) || liveText(event.error)
    return {
      type: 'status',
      status: 'failed',
      message: message || 'Pi Live runtime exited',
    }
  }
  if (type === 'extension_error') {
    const message = liveText(event.errorMessage) || liveText(event.error)
    return { type: 'error', message: message || 'Pi Live extension failed' }
  }
  return undefined
}

export function normalizePiLiveRuntimeEvent(value: LiveRuntimeEvent): LiveRuntimeEvent {
  const normalizedEvent = normalizePiLiveEvent(value.event)
  return normalizedEvent ? { ...value, normalizedEvent } : value
}

/**
 * Generic Live Adapter facade for the existing Pi runtime.
 *
 * Pi-only controls stay on PiLiveService while common cross-agent operations
 * are exposed through the Live registry.
 */
export class PiLiveAdapter implements LiveAdapter {
  readonly manifest = piLiveAdapterManifest
  readonly capabilities: ReadonlySet<LiveCapabilityName> = createLiveCapabilitySet(CAPABILITIES)
  readonly inputCapabilities = INPUT_CAPABILITIES
  readonly startCapabilities = {
    workspace: 'required',
    title: 'optional',
  } as const

  constructor(
    readonly service: PiLiveService,
    private readonly attachments: LiveAttachmentService,
    private readonly storage?: StorageService,
  ) {}

  availability() {
    return this.service.availability()
  }

  list(): Promise<PiLiveRuntimeState[]> {
    return this.service.list()
  }

  start(input: unknown): Promise<PiLiveRuntimeState> {
    return this.service.start(piStartInput(input))
  }

  async resume(logicalSessionId: string): Promise<PiLiveRuntimeState> {
    if (!this.storage) throw new Error('Pi Live history interactions are unavailable')
    return this.service.start(await resolvePiLiveHistoryInput(this.storage, logicalSessionId, 'continue'))
  }

  async fork(logicalSessionId: string): Promise<PiLiveRuntimeState> {
    if (!this.storage) throw new Error('Pi Live history interactions are unavailable')
    return this.service.start(await resolvePiLiveHistoryInput(this.storage, logicalSessionId, 'fork'))
  }

  state(runtimeSessionId: string): Promise<PiLiveRuntimeState> {
    return this.service.state(runtimeSessionId)
  }

  async snapshot(runtimeSessionId: string, since?: string, window?: LiveSnapshotWindow): Promise<PiLiveSnapshot> {
    const canonicalSelector = isCanonicalHistoryCursor(since)
      || isCanonicalHistoryCursor(window?.before)
      || isCanonicalHistoryCursor(window?.after)
      || isCanonicalHistoryCursor(window?.around)

    if (canonicalSelector) {
      if (!this.storage) throw new Error('Canonical Pi Live history is unavailable without storage')
      const state = await this.service.state(runtimeSessionId)
      if (!state.logicalSessionId) throw new Error('Canonical Pi Live history has no logical session identity')
      return canonicalPiLiveSnapshot(this.storage, state, state.logicalSessionId, since, window)
    }

    const snapshot = await this.service.snapshot(runtimeSessionId, since, window)
    if (!this.storage
      || snapshot.entries.length > 0
      || snapshot.state.status === 'ready'
      || !snapshot.state.logicalSessionId) {
      return snapshot
    }

    // While the Worker hydrates, render the already-canonicalized AgentLens
    // history instead of blocking on AgentSession creation. Once Ready, the
    // normal Pi SessionManager Snapshot replaces/reconciles this temporary view.
    return canonicalPiLiveSnapshot(
      this.storage,
      snapshot.state,
      snapshot.state.logicalSessionId,
      since,
      window,
    ).catch(() => snapshot)
  }

  historyIndex(runtimeSessionId: string, query?: LiveHistoryIndexQuery) {
    return this.service.historyIndex(runtimeSessionId, query)
  }

  async modelControl(runtimeSessionId: string): Promise<LiveModelControl | null> {
    const [controls, state] = await Promise.all([
      this.service.controls(runtimeSessionId),
      this.service.state(runtimeSessionId),
    ])
    if (!controls.models.length) return null
    const current = liveRecord(state.model)
    const currentProvider = liveText(current.provider)
    const currentId = liveText(current.id) || liveText(current.modelId)
    const options = controls.models.map(model => ({
      value: JSON.stringify([model.provider, model.id]),
      label: model.name || model.id,
      description: model.name && model.name !== model.id
        ? `${model.provider} · ${model.id}`
        : model.provider,
    }))
    const currentValue = currentProvider && currentId ? JSON.stringify([currentProvider, currentId]) : undefined
    const control: LiveModelControl = {
      capability: 'model-switching',
      label: 'Model',
      ...(currentValue && options.some(option => option.value === currentValue) ? { value: currentValue } : {}),
      options,
    }
    return isLiveModelControl(control) ? control : null
  }

  async setModelControl(runtimeSessionId: string, value: string): Promise<PiLiveRuntimeState> {
    const control = await this.modelControl(runtimeSessionId)
    if (!control || !control.options.some(option => option.value === value)) {
      throw new Error(`Pi Live model control does not offer value: ${value}`)
    }
    let parsed: unknown
    try { parsed = JSON.parse(value) } catch { parsed = null }
    if (!Array.isArray(parsed) || parsed.length !== 2
      || typeof parsed[0] !== 'string' || !parsed[0]
      || typeof parsed[1] !== 'string' || !parsed[1]) {
      throw new Error('Pi Live model control value is invalid')
    }
    return this.service.setModel(runtimeSessionId, parsed[0], parsed[1])
  }

  async thinkingControl(runtimeSessionId: string) {
    const control = (await this.service.controls(runtimeSessionId)).thinking
    return isLiveThinkingControl(control) ? control : null
  }

  async setThinkingControl(runtimeSessionId: string, value: string): Promise<PiLiveRuntimeState> {
    const control = await this.thinkingControl(runtimeSessionId)
    if (!control || !control.options.some(option => option.value === value)) {
      throw new Error(`Pi Live thinking control does not offer value: ${value}`)
    }
    return this.service.setThinkingLevel(runtimeSessionId, value)
  }

  respondToExtension(runtimeSessionId: string, requestId: string, response: unknown): Promise<void> {
    return this.service.respondToExtension(runtimeSessionId, requestId, response)
  }

  async commands(runtimeSessionId: string): Promise<readonly LiveCommand[]> {
    return (await this.service.commands(runtimeSessionId)).map(command => ({
      value: `/${command.name}`,
      label: `/${command.name}`,
      ...(command.description ? { description: command.description } : {}),
      group: command.source,
    }))
  }
  messageActions(runtimeSessionId: string) {
    return this.service.messageActions(runtimeSessionId)
  }

  executeMessageAction(runtimeSessionId: string, actionId: string, targetEntryId: string) {
    return this.service.executeMessageAction(runtimeSessionId, actionId, targetEntryId)
  }

  runtimeDisclosures(runtimeSessionId: string) {
    return this.service.runtimeDisclosures(runtimeSessionId)
  }

  executeRuntimeAction(runtimeSessionId: string, actionId: string) {
    return this.service.executeRuntimeAction(runtimeSessionId, actionId)
  }

  workspaceFileReferences(runtimeSessionId: string, query: string, limit?: number) {
    return this.service.workspaceFileReferences(runtimeSessionId, query, limit)
  }

  private async resolveMessage(message: LiveMessage): Promise<{
    text: string
    images: PiLiveImageInput[]
    attachmentIds: string[]
  }> {
    requireLiveMessageSupport(message, this.inputCapabilities, this.manifest.displayName)
    const text: string[] = []
    const images: PiLiveImageInput[] = []
    const attachmentIds: string[] = []

    for (const part of message.parts) {
      if (part.type === 'text' || part.type === 'large-text') {
        text.push(part.text)
        continue
      }
      if (part.type === 'file') {
        throw new Error(`${this.manifest.displayName} does not support Live input part: file`)
      }

      const attachment = await this.attachments.get(part.attachmentId)
      if (!attachment) {
        throw new Error(`Live image attachment is unavailable: ${part.attachmentId}`)
      }
      const mimeType = (part.mimeType || attachment.mimeType || '').trim().toLowerCase()
      if (!mimeType.startsWith('image/')) {
        throw new Error(`Live image attachment requires an image MIME type: ${part.attachmentId}`)
      }
      images.push({
        type: 'image',
        data: Buffer.from(attachment.data).toString('base64'),
        mimeType,
      })
      attachmentIds.push(part.attachmentId)
    }

    return { text: text.join('\n\n'), images, attachmentIds }
  }

  private async sendResolved(
    runtimeSessionId: string,
    message: LiveMessage,
    behavior: 'normal' | 'steer' | 'follow-up',
  ): Promise<void> {
    const resolved = await this.resolveMessage(message)
    if (behavior === 'steer') {
      await this.service.steer(runtimeSessionId, resolved.text, resolved.images)
    } else if (behavior === 'follow-up') {
      await this.service.followUp(runtimeSessionId, resolved.text, resolved.images)
    } else {
      await this.service.prompt(runtimeSessionId, resolved.text, undefined, resolved.images)
    }
    await Promise.all(resolved.attachmentIds.map(
      attachmentId => this.attachments.remove(attachmentId).catch(() => undefined),
    ))
  }

  send(
    runtimeSessionId: string,
    message: LiveMessageInput,
    options: LiveSendOptions = {},
  ): Promise<void> {
    return dispatchLiveSend(message, options, {
      normal: value => this.sendResolved(runtimeSessionId, value, 'normal'),
      steer: value => this.sendResolved(runtimeSessionId, value, 'steer'),
      followUp: value => this.sendResolved(runtimeSessionId, value, 'follow-up'),
    })
  }

  subscribe(
    runtimeSessionId: string,
    listener: (event: LiveRuntimeEvent) => void,
  ): () => void {
    return this.service.subscribe(
      runtimeSessionId,
      event => listener(normalizePiLiveRuntimeEvent(event)),
    )
  }

  queueState(runtimeSessionId: string) {
    return this.service.queueState(runtimeSessionId)
  }

  clearQueue(runtimeSessionId: string) {
    return this.service.clearQueue(runtimeSessionId)
  }

  async interrupt(runtimeSessionId: string) {
    const restoredQueue = await this.service.abort(runtimeSessionId)
    return { restoredQueue }
  }

  terminate(runtimeSessionId: string): Promise<void> {
    return this.service.terminate(runtimeSessionId)
  }

  dispose(): Promise<void> {
    return this.service.dispose()
  }
}
