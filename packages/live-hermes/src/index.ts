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

export class HermesLiveAdapter implements LiveAdapter {
  readonly manifest = hermesLiveManifest
  readonly capabilities: ReadonlySet<LiveCapabilityName> = createLiveCapabilitySet(CAPABILITIES)

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
    message: string,
    options: LiveSendOptions = {},
  ): Promise<void> {
    return dispatchLiveSend(message, options, {
      normal: value => this.service.prompt(runtimeSessionId, value),
    })
  }

  subscribe(
    runtimeSessionId: string,
    listener: (event: LiveRuntimeEvent) => void,
  ): () => void {
    return this.service.subscribe(runtimeSessionId, listener)
  }

  interrupt(runtimeSessionId: string): Promise<unknown> {
    return this.service.interrupt(runtimeSessionId)
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
