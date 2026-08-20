import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import './context'
import {
  assertAgentLensPluginCompatible,
  type AgentLensCordisPlugin,
} from './plugin'

export type AgentLensApplicationState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'

export interface AgentLensPluginRegistration {
  plugin: AgentLensCordisPlugin<any>
  config?: unknown
}

export interface AgentLensApplicationOptions {
  plugins?: readonly AgentLensPluginRegistration[]
}

export class AgentLensApplication {
  readonly context: Context

  private readonly registrations: AgentLensPluginRegistration[] = []
  private readonly fibers: Fiber[] = []
  private _state: AgentLensApplicationState = 'idle'

  constructor(options: AgentLensApplicationOptions = {}) {
    this.context = new Context()
    if (options.plugins) {
      this.registrations.push(...options.plugins)
    }
  }

  get state(): AgentLensApplicationState {
    return this._state
  }

  use(plugin: AgentLensCordisPlugin<any>, config?: unknown): this {
    if (this._state !== 'idle') {
      throw new Error('Plugins can only be registered before AgentLens starts')
    }

    assertAgentLensPluginCompatible(plugin.manifest)
    this.registrations.push(config === undefined ? { plugin } : { plugin, config })
    return this
  }

  async start(): Promise<void> {
    if (this._state !== 'idle') {
      throw new Error(`AgentLens cannot start from state ${this._state}`)
    }

    this._state = 'starting'
    const load = this.context.plugin.bind(this.context) as (
      plugin: Plugin<any>,
      config?: unknown,
    ) => Fiber & PromiseLike<Fiber>

    try {
      for (const registration of this.registrations) {
        assertAgentLensPluginCompatible(registration.plugin.manifest)
        const fiber = registration.config === undefined
          ? await load(registration.plugin)
          : await load(registration.plugin, registration.config)
        this.fibers.push(fiber)
      }
      this._state = 'running'
    } catch (error) {
      await this.disposeLoadedFibers()
      this._state = 'stopped'
      throw error
    }
  }

  async stop(): Promise<void> {
    if (this._state === 'stopped') return
    if (this._state === 'idle') {
      this._state = 'stopped'
      return
    }
    if (this._state !== 'running') {
      throw new Error(`AgentLens cannot stop from state ${this._state}`)
    }

    this._state = 'stopping'
    try {
      await this.disposeLoadedFibers()
    } finally {
      this._state = 'stopped'
    }
  }

  private async disposeLoadedFibers(): Promise<void> {
    while (this.fibers.length) {
      const fiber = this.fibers.pop()!
      await fiber.dispose()
    }
  }
}
