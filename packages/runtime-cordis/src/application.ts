import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import type {
  AgentIntegrationCapability,
  AgentIntegrationCapabilityStatus,
  AgentIntegrationRuntimeStatus,
} from '@agent-lens/core'
import './context'
import {
  assertAgentLensPluginCompatible,
  type AgentLensCordisPlugin,
} from './plugin'
import type { AgentLensIntegration } from './integration'

export type AgentLensApplicationState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'

interface PluginRegistration {
  plugin: Plugin<unknown>
  config?: unknown
  validateManifest: boolean
  integrationId?: string
  componentPluginId?: string
  componentCapabilities?: readonly AgentIntegrationCapability[]
}

interface RegisteredIntegration {
  integration: AgentLensIntegration
  enabled: boolean
  authorizedCapabilities: ReadonlySet<AgentIntegrationCapability>
}

export interface AgentLensIntegrationFailure {
  integrationId: string
  componentPluginId: string
  error: unknown
}

export interface AgentLensApplicationOptions {
  plugins?: ReadonlyArray<{
    plugin: AgentLensCordisPlugin<unknown>
    config?: unknown
  }>
}

function integrationAvailability(
  capabilities: readonly AgentIntegrationCapabilityStatus[],
): AgentIntegrationRuntimeStatus['availability'] {
  if (!capabilities.length) return 'unavailable'
  const available = capabilities.filter(item => item.availability === 'available').length
  const unavailable = capabilities.filter(item => item.availability === 'unavailable').length
  const errors = capabilities.filter(item => item.availability === 'error').length
  if (errors === capabilities.length) return 'error'
  if (unavailable === capabilities.length) return 'unavailable'
  if (errors > 0 || unavailable > 0) return 'partial'
  if (available === capabilities.length) return 'available'
  return 'partial'
}

export class AgentLensApplication {
  readonly context: Context

  private readonly registrations: PluginRegistration[] = []
  private readonly fibers: Fiber[] = []
  private readonly integrations = new Map<string, RegisteredIntegration>()
  private readonly failedIntegrations = new Set<string>()
  private readonly _integrationFailures: AgentLensIntegrationFailure[] = []
  private readonly capabilityStatus = new Map<string, Map<AgentIntegrationCapability, AgentIntegrationCapabilityStatus>>()
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

  get integrationFailures(): readonly AgentLensIntegrationFailure[] {
    return this._integrationFailures
  }

  listIntegrationStatuses(): AgentIntegrationRuntimeStatus[] {
    return [...this.integrations.values()].map(({ integration, enabled, authorizedCapabilities }) => {
      const overrides = this.capabilityStatus.get(integration.manifest.integrationId)
      const authorization = new Map<AgentIntegrationCapability, AgentIntegrationCapabilityStatus>()
      for (const component of integration.components) {
        if (component.authorization !== 'explicit') continue
        const granted = component.capabilities.every(capability => authorizedCapabilities.has(capability))
        for (const capability of component.capabilities) {
          authorization.set(capability, {
            capability,
            availability: enabled && !granted ? 'unavailable' : 'available',
            authorization: granted ? 'granted' : 'required',
            ...(!granted && enabled ? { reason: '等待用户授权' } : {}),
          })
        }
      }
      const capabilities = integration.manifest.capabilities.map(capability =>
        overrides?.get(capability)
        ?? authorization.get(capability)
        ?? {
          capability,
          availability: 'available' as const,
        }
      )
      return {
        integrationId: integration.manifest.integrationId,
        productId: integration.manifest.productId,
        enabled,
        availability: integrationAvailability(capabilities),
        capabilities,
      }
    })
  }

  integrationStatus(productId: string): AgentIntegrationRuntimeStatus | null {
    return this.listIntegrationStatuses().find(status => status.productId === productId) ?? null
  }

  async resolveIntegrationStatus(productId: string): Promise<AgentIntegrationRuntimeStatus | null> {
    const base = this.integrationStatus(productId)
    if (!base || !base.enabled) return base

    const registered = this.integrations.get(base.integrationId)
    if (!registered || !registered.integration.manifest.capabilities.includes('live')) return base
    const currentLive = base.capabilities.find(item => item.capability === 'live')
    if (currentLive?.availability !== 'available') return base

    const lives = this.context.get('lives')
    const adapter = lives?.get(base.integrationId) ?? lives?.get(productId) ?? null
    const next = base.capabilities.map(item => ({ ...item }))
    const liveComponent = registered.integration.components.find(component =>
      component.capabilities.includes('live')
    )
    const affected = liveComponent?.capabilities ?? ['live']

    if (!adapter) {
      for (const capability of affected) {
        const index = next.findIndex(item => item.capability === capability)
        if (index < 0 || next[index]!.availability !== 'available') continue
        next[index] = {
          capability,
          availability: 'unavailable',
          reason: 'Live Adapter 未加载',
        }
      }
      return { ...base, availability: integrationAvailability(next), capabilities: next }
    }

    try {
      const availability = await adapter.availability()
      if (availability.available) return base
      for (const capability of affected) {
        const index = next.findIndex(item => item.capability === capability)
        if (index < 0 || next[index]!.availability !== 'available') continue
        next[index] = {
          capability,
          availability: 'unavailable',
          ...(availability.reason ? { reason: availability.reason } : {}),
        }
      }
    } catch {
      for (const capability of affected) {
        const index = next.findIndex(item => item.capability === capability)
        if (index < 0 || next[index]!.availability !== 'available') continue
        next[index] = {
          capability,
          availability: 'error',
          reason: 'Live 可用性检查失败',
        }
      }
    }
    return { ...base, availability: integrationAvailability(next), capabilities: next }
  }

  /** Register an AgentLens extension plugin with Plugin API validation. */
  use(plugin: AgentLensCordisPlugin<unknown>, config?: unknown): this {
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
   * Register one product-level Agent Integration.
   *
   * This is only composition metadata: each component is still loaded by the
   * existing AgentLens/Cordis plugin lifecycle. Integration-owned component
   * failures are isolated from Core and other integrations.
   */
  useIntegration(
    integration: AgentLensIntegration,
    options: {
      enabled?: boolean
      authorizedCapabilities?: readonly AgentIntegrationCapability[]
    } = {},
  ): this {
    this.assertConfigurable()
    if (this.integrations.has(integration.manifest.integrationId)) {
      throw new Error(`Agent Integration already registered: ${integration.manifest.integrationId}`)
    }
    const enabled = options.enabled ?? true
    const authorizedCapabilities = new Set(options.authorizedCapabilities ?? [])
    this.integrations.set(integration.manifest.integrationId, {
      integration,
      enabled,
      authorizedCapabilities,
    })

    for (const component of integration.components) {
      if (component.activation === 'enabled' && !enabled) continue
      if (
        component.authorization === 'explicit'
        && !component.capabilities.every(capability => authorizedCapabilities.has(capability))
      ) continue
      if (component.lifecycle === 'plugin') {
        assertAgentLensPluginCompatible(component.plugin.manifest)
      }
      this.registrations.push({
        plugin: component.plugin,
        ...(component.config === undefined ? {} : { config: component.config }),
        validateManifest: component.lifecycle === 'plugin',
        integrationId: integration.manifest.integrationId,
        componentPluginId: component.pluginId,
        componentCapabilities: component.capabilities,
      })
    }
    return this
  }

  /**
   * Register an internal Cordis composition plugin.
   * This is for AgentLens runtime wiring (for example Core Service providers),
   * not a second public plugin API.
   */
  useRuntime(plugin: Plugin<unknown>, config?: unknown): this {
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
    this.failedIntegrations.clear()
    this._integrationFailures.length = 0
    this.capabilityStatus.clear()
    const load = this.context.plugin.bind(this.context) as (
      plugin: Plugin<unknown>,
      config?: unknown,
    ) => Fiber & PromiseLike<Fiber>

    try {
      for (const registration of this.registrations) {
        if (registration.integrationId && this.failedIntegrations.has(registration.integrationId)) {
          this.markComponentUnavailable(registration, '同一智能体集成的前序组件启动失败')
          continue
        }
        try {
          if (registration.validateManifest) {
            assertAgentLensPluginCompatible(
              (registration.plugin as AgentLensCordisPlugin<unknown>).manifest,
            )
          }
          const fiber = registration.config === undefined
            ? await load(registration.plugin)
            : await load(registration.plugin, registration.config)
          this.fibers.push(fiber)
        } catch (error) {
          if (!registration.integrationId || !registration.componentPluginId) throw error
          this.failedIntegrations.add(registration.integrationId)
          this.markComponentError(registration)
          this._integrationFailures.push({
            integrationId: registration.integrationId,
            componentPluginId: registration.componentPluginId,
            error,
          })
          console.error(
            `[AgentLens] integration component failed: ${registration.integrationId} / ${registration.componentPluginId}`,
            error,
          )
        }
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

  private markComponentError(registration: PluginRegistration): void {
    if (!registration.integrationId) return
    const statuses = this.capabilityStatus.get(registration.integrationId) ?? new Map()
    for (const capability of registration.componentCapabilities ?? []) {
      statuses.set(capability, {
        capability,
        availability: 'error',
        reason: `组件启动失败：${registration.componentPluginId ?? 'unknown'}`,
      })
    }
    this.capabilityStatus.set(registration.integrationId, statuses)
  }

  private markComponentUnavailable(registration: PluginRegistration, reason: string): void {
    if (!registration.integrationId) return
    const statuses = this.capabilityStatus.get(registration.integrationId) ?? new Map()
    for (const capability of registration.componentCapabilities ?? []) {
      if (statuses.has(capability)) continue
      statuses.set(capability, {
        capability,
        availability: 'unavailable',
        reason,
      })
    }
    this.capabilityStatus.set(registration.integrationId, statuses)
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
