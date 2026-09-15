import { Buffer } from 'node:buffer'
import { isLiveThinkingControl } from '@agent-lens/core'
import type {
  LiveAdapter,
  LiveAdapterManifest,
  LiveAttachmentService,
  LiveCapabilityName,
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
  const input = value as Partial<PiLiveStartInput>
  if (typeof input.cwd !== 'string' || !input.cwd.trim()) {
    throw new TypeError('Pi Live start input requires cwd')
  }
  return input as PiLiveStartInput
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
    return this.service.subscribe(runtimeSessionId, listener)
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
