import type {
  LiveAdapter,
  LiveAdapterManifest,
  LiveCapabilityName,
  LiveRuntimeEvent,
  LiveSendOptions,
} from '@agent-lens/core'
import {
  createLiveCapabilitySet,
  dispatchLiveSend,
} from '@agent-lens/live-support'
import type {
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

  constructor(readonly service: PiLiveService) {}

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

  send(
    runtimeSessionId: string,
    message: string,
    options: LiveSendOptions = {},
  ): Promise<void> {
    return dispatchLiveSend(message, options, {
      normal: value => this.service.prompt(runtimeSessionId, value),
      steer: value => this.service.steer(runtimeSessionId, value),
      followUp: value => this.service.followUp(runtimeSessionId, value),
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
