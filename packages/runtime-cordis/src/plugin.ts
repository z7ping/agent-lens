import type { Plugin } from '@deepseek-ai/cordis'
import {
  AGENT_LENS_PLUGIN_API_VERSION,
  type AgentLensPluginManifest,
  type CoreEventMap,
  type Disposable,
  type SourceDefinition,
  type StorageService,
} from '@agent-lens/core'
import type { AgentLensContext } from './context'

export type AgentLensCordisPlugin<T = any> = Plugin<T> & {
  readonly manifest: AgentLensPluginManifest
}

export function assertAgentLensPluginCompatible(
  manifest: AgentLensPluginManifest,
): void {
  if (manifest.apiVersion !== AGENT_LENS_PLUGIN_API_VERSION) {
    throw new Error(
      `Unsupported AgentLens Plugin API ${manifest.apiVersion}; expected ${AGENT_LENS_PLUGIN_API_VERSION}`,
    )
  }
}

export function defineAgentLensPlugin<P extends Plugin<any>>(
  manifest: AgentLensPluginManifest,
  plugin: P,
): P & { readonly manifest: AgentLensPluginManifest } {
  assertAgentLensPluginCompatible(manifest)

  Object.defineProperty(plugin, 'manifest', {
    value: Object.freeze({ ...manifest }),
    enumerable: true,
    configurable: false,
    writable: false,
  })

  return plugin as P & { readonly manifest: AgentLensPluginManifest }
}

export function defineSourcePlugin(
  definition: SourceDefinition,
): AgentLensCordisPlugin {
  const applySource = Object.assign(
    (ctx: AgentLensContext) => {
      const registration = ctx.sources.register(definition)
      return () => registration.dispose()
    },
    { inject: ['sources'] },
  )

  return defineAgentLensPlugin(definition.manifest, applySource)
}

export interface StoragePluginInstance extends Disposable {
  readonly storage: StorageService
}

export type StoragePluginFactory<Config> = (
  config: Config,
) => StoragePluginInstance | Promise<StoragePluginInstance>

export function defineStoragePlugin<Config>(
  manifest: AgentLensPluginManifest,
  factory: StoragePluginFactory<Config>,
): AgentLensCordisPlugin<Config> {
  const applyStorage = async (ctx: AgentLensContext, config: Config) => {
    const instance = await factory(config)
    const unprovide = ctx.provide('storage', instance.storage)
    return async () => {
      unprovide()
      await instance.dispose()
    }
  }

  return defineAgentLensPlugin(manifest, applyStorage)
}

export interface SurfaceRuntimeContext {
  readonly storage: StorageService
  onObservationCommitted(
    listener: (event: CoreEventMap['observation/committed']) => void,
  ): void
}

export type SurfacePluginFactory<Config> = (
  runtime: SurfaceRuntimeContext,
  config: Config,
) => Disposable | Promise<Disposable>

export function defineSurfacePlugin<Config>(
  manifest: AgentLensPluginManifest,
  factory: SurfacePluginFactory<Config>,
): AgentLensCordisPlugin<Config> {
  const applySurface = Object.assign(
    async (ctx: AgentLensContext, config: Config) => {
      const instance = await factory({
        storage: ctx.storage,
        onObservationCommitted(listener) {
          ctx.on('observation/committed', listener)
        },
      }, config)
      return async () => {
        await instance.dispose()
      }
    },
    { inject: ['storage'] },
  )

  return defineAgentLensPlugin(manifest, applySurface)
}
