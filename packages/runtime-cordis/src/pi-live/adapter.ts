import { Buffer } from 'node:buffer'
import { isLiveThinkingControl } from '@agent-lens/core'
import type {
  LiveAdapter,
  LiveAdapterManifest,
  LiveAttachmentService,
  LiveCapabilityName,
  LiveEvent,
  LiveMessage,
  LiveMessageInput,
  LiveRuntimeEvent,
  LiveSendOptions,
} from '@agent-lens/core'
import {
  createLiveCapabilitySet,
  createLiveInputCapabilities,
  dispatchLiveSend,
  requireLiveMessageSupport,
} from '@agent-lens/live-support'
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
  const common = contentIndex === undefined ? {} : { contentIndex }

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
  if (type === 'runtime_exit' || type === 'extension_error') {
    const message = liveText(event.errorMessage) || liveText(event.error)
    return { type: 'error', message: message || 'Pi Live runtime failed' }
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

  constructor(readonly service: PiLiveService, private readonly attachments: LiveAttachmentService) {}

  availability() {
    return this.service.availability()
  }

  list(): Promise<PiLiveRuntimeState[]> {
    return this.service.list()
  }

  start(input: unknown): Promise<PiLiveRuntimeState> {
    return this.service.start(piStartInput(input))
  }

  state(runtimeSessionId: string): Promise<PiLiveRuntimeState> {
    return this.service.state(runtimeSessionId)
  }

  snapshot(runtimeSessionId: string, since?: string): Promise<PiLiveSnapshot> {
    return this.service.snapshot(runtimeSessionId, since)
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

  interrupt(runtimeSessionId: string): Promise<unknown> {
    return this.service.abort(runtimeSessionId)
  }

  terminate(runtimeSessionId: string): Promise<void> {
    return this.service.terminate(runtimeSessionId)
  }

  dispose(): Promise<void> {
    return this.service.dispose()
  }
}
