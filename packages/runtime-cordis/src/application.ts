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

interface PluginRegistration {
  plugin: Plugin<any>
  config?: unknown
  validateManifest: boolean
}

export interface AgentLensApplicationOptions {
  plugins?: ReadonlyArray<{
    plugin: AgentLensCordisPlugin<any>
    config?: unknown
  }>
}

export class AgentLensApplication {
  readonly context: Context

  private readonly registrations: PluginRegistration[] = []
  private readonly fibers: Fiber[] = []
  private _state: AgentLensApplicationState = 'idle'

  constructor(options: AgentLensApplicationOptions = {}) {
    this.context = new Context()
    for (const registration of options.plugins ?? []) {
      this.use(registration.plugin, registration.config)
    }
  }

  get state(): AgentLensApplicationState {
    return this._state
  }

  /** Register an AgentLens extension plugin with Plugin API validation. */
  use(plugin: AgentLensCordisPlugin<any>, config?: unknown): this {
    this.assertConfigurable()
    assertAgentLensPluginCompatible(plugin.manifest)
    this.registrations.push({
      plugin,
      ...(config === undefined ? {} : { config }),
      validateManifest: true,
    })
    return this
  }

  /**
   * Register an internal Cordis composition plugin.
   * This is for AgentLens runtime wiring (for example Core Service providers),
   * not a second public plugin API.
   */
  useRuntime(plugin: Plugin<any>, config?: unknown): this {
    this.assertConfigurable()
    this.registrations.push({
      plugin,
      ...(config === undefined ? {} : { config }),
      validateManifest: false,
    })
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
        if (registration.validateManifest) {
          assertAgentLensPluginCompatible(
            (registration.plugin as AgentLensCordisPlugin<any>).manifest,
          )
        }
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

  private assertConfigurable(): void {
    if (this._state !== 'idle') {
      throw new Error('Plugins can only be registered before AgentLens starts')
    }
  }

  private async disposeLoadedFibers(): Promise<void> {
    while (this.fibers.length) {
      const fiber = this.fibers.pop()!
      await fiber.dispose()
    }
  }
}
