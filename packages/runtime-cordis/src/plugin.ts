import type { Plugin } from '@deepseek-ai/cordis'
import {
  AGENT_LENS_PLUGIN_API_VERSION,
  type AgentLensPluginManifest,
  type SourceDefinition,
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
