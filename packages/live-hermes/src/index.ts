import type {
  LiveAdapter,
  LiveAdapterManifest,
  LiveCapabilityName,
  LiveEvent,
  LiveMessageInput,
  LiveRuntimeEvent,
  LiveSendOptions,
} from '@agent-lens/core'
import {
  createLiveCapabilitySet,
  createLiveInputCapabilities,
  dispatchLiveSend,
  liveMessageToPlainText,
} from '@agent-lens/live-support'
import {
  defineAgentLensPlugin,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import {
  HermesApiClient,
  resolveHermesApiClientConfig,
  type HermesApiClientConfig,
} from './client.js'
import { DefaultHermesLiveService } from './service.js'

const CAPABILITIES = [
  'create',
  'send',
  'stream',
  'interrupt',
] as const satisfies readonly LiveCapabilityName[]

const INPUT_CAPABILITIES = createLiveInputCapabilities({
  text: 'native',
  largeText: 'transform',
  image: 'unsupported',
  file: 'unsupported',
  multiline: 'native',
})

export const hermesLiveManifest: LiveAdapterManifest = {
  pluginId: '@agent-lens/live-hermes',
  pluginVersion: '1.0.0-alpha.5',
  apiVersion: '1.0',
  pluginType: 'live',
  displayName: 'Hermes Live',
  liveId: 'hermes',
  productId: 'hermes',
  capabilities: [...CAPABILITIES],
}

function hermesRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function hermesText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function hermesNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Hermes Run Events already expose a stable public event vocabulary. The
 * Adapter maps that vocabulary into AgentLens Live events and leaves the
 * original payload untouched for diagnostics.
 */
export function normalizeHermesLiveEvent(event: Readonly<Record<string, unknown>>): LiveEvent | undefined {
  const name = hermesText(event.event) || hermesText(event.type)

  if (name === 'runtime_status') {
    const status = hermesText(event.status)
    if (status === 'initializing' || status === 'ready' || status === 'failed'
      || status === 'terminating' || status === 'terminated') {
      return {
        type: 'status',
        status,
        ...(hermesText(event.error) ? { message: hermesText(event.error) } : {}),
      }
    }
  }
  if (name === 'run.created' || name === 'run.started') {
    return { type: 'status', status: 'running' }
  }
  if (name === 'message.started') {
    const message = hermesRecord(event.message)
    const rawRole = hermesText(message.role)
    const role = rawRole === 'user' || rawRole === 'assistant' || rawRole === 'tool' || rawRole === 'system'
      ? rawRole
      : 'unknown'
    const messageId = hermesText(message.id) || hermesText(event.message_id)
    return {
      type: 'message.start',
      role,
      ...(messageId ? { messageId } : {}),
    }
  }
  if (name === 'assistant.delta') {
    const delta = hermesText(event.delta)
    if (!delta) return undefined
    const messageId = hermesText(event.message_id)
    return {
      type: 'text.delta',
      delta,
      ...(messageId ? { messageId } : {}),
    }
  }
  if (name === 'assistant.completed') {
    const text = hermesText(event.content)
    const messageId = hermesText(event.message_id)
    return {
      type: 'text.end',
      text,
      ...(messageId ? { messageId } : {}),
    }
  }
  if (name === 'reasoning.available'
    || (name === 'tool.progress' && hermesText(event.tool_name) === '_thinking')) {
    const delta = hermesText(event.text) || hermesText(event.delta) || hermesText(event.preview)
    return delta ? { type: 'reasoning.delta', delta } : undefined
  }
  if (name === 'tool.started') {
    const tool = hermesText(event.tool) || hermesText(event.tool_name) || 'tool'
    const callId = hermesText(event.tool_call_id) || hermesText(event.call_id)
    const inputPreview = hermesText(event.preview)
    return {
      type: 'tool.start',
      ...(callId ? { callId } : {}),
      name: tool,
      ...(inputPreview ? { inputPreview } : {}),
    }
  }
  if (name === 'tool.completed' || name === 'tool.failed') {
    const tool = hermesText(event.tool) || hermesText(event.tool_name) || undefined
    const callId = hermesText(event.tool_call_id) || hermesText(event.call_id)
    const output = hermesText(event.preview)
    const durationSeconds = hermesNumber(event.duration)
    const failed = name === 'tool.failed' || event.error === true
    return {
      type: 'tool.end',
      ...(callId ? { callId } : {}),
      ...(tool ? { name: tool } : {}),
      status: failed ? 'error' : 'success',
      ...(output ? { output } : {}),
      ...(durationSeconds === undefined ? {} : { durationMs: Math.max(0, durationSeconds * 1_000) }),
    }
  }
  if (name === 'run.completed') return { type: 'completed', status: 'completed' }
  if (name === 'run.cancelled') return { type: 'completed', status: 'cancelled' }
  if (name === 'run.interrupted') return { type: 'completed', status: 'interrupted' }
  if (name === 'run.failed') {
    return {
      type: 'completed',
      status: 'failed',
      ...(hermesText(event.error) ? { message: hermesText(event.error) } : {}),
    }
  }
  if (name === 'transport.error' || name === 'error') {
    return {
      type: 'error',
      message: hermesText(event.error) || hermesText(event.message) || 'Hermes Live transport failed',
    }
  }
  return undefined
}

export class HermesLiveAdapter implements LiveAdapter {
  readonly manifest = hermesLiveManifest
  readonly capabilities: ReadonlySet<LiveCapabilityName> = createLiveCapabilitySet(CAPABILITIES)
  readonly inputCapabilities = INPUT_CAPABILITIES
  readonly startCapabilities = {
    workspace: 'unsupported',
    title: 'optional',
  } as const

  constructor(readonly service: DefaultHermesLiveService) {}

  availability() {
    return this.service.availability()
  }

  list() {
    return this.service.list()
  }

  start(input: unknown) {
    return this.service.start(input)
  }

  state(runtimeSessionId: string) {
    return this.service.state(runtimeSessionId)
  }

  snapshot(runtimeSessionId: string) {
    return this.service.snapshot(runtimeSessionId)
  }

  send(
    runtimeSessionId: string,
    message: LiveMessageInput,
    options: LiveSendOptions = {},
  ): Promise<void> {
    return dispatchLiveSend(message, options, {
      normal: value => this.service.prompt(
        runtimeSessionId,
        liveMessageToPlainText(value, this.inputCapabilities, this.manifest.displayName),
      ),
    })
  }

  subscribe(
    runtimeSessionId: string,
    listener: (event: LiveRuntimeEvent) => void,
  ): () => void {
    return this.service.subscribe(runtimeSessionId, value => {
      const normalizedEvent = normalizeHermesLiveEvent(value.event)
      listener(normalizedEvent ? { ...value, normalizedEvent } : value)
    })
  }

  async interrupt(runtimeSessionId: string) {
    await this.service.interrupt(runtimeSessionId)
    return {}
  }

  terminate(runtimeSessionId: string): Promise<void> {
    return this.service.terminate(runtimeSessionId)
  }

  dispose(): Promise<void> {
    return this.service.dispose()
  }
}

export type HermesLivePluginConfig = HermesApiClientConfig

const applyHermesLive = Object.assign(
  async (ctx: AgentLensContext, config: HermesLivePluginConfig = {}) => {
    const client = new HermesApiClient(await resolveHermesApiClientConfig(config))
    const adapter = new HermesLiveAdapter(new DefaultHermesLiveService(client))
    const registration = ctx.lives.register(adapter)
    return async () => {
      await registration.dispose()
      await adapter.dispose()
    }
  },
  { inject: ['lives'] },
)

export const hermesLivePlugin = defineAgentLensPlugin(
  hermesLiveManifest,
  applyHermesLive,
)

export * from './client.js'
export * from './service.js'
