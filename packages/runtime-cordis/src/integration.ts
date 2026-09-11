import type { Plugin } from '@deepseek-ai/cordis'
import {
  AGENT_LENS_PLUGIN_API_VERSION,
  type AgentIntegrationManifest,
} from '@agent-lens/core'
import type { AgentLensCordisPlugin } from './plugin'

export type AgentLensIntegrationComponent =
  | {
      pluginId: string
      activation: 'catalog' | 'enabled'
      lifecycle: 'plugin'
      plugin: AgentLensCordisPlugin<unknown>
      config?: unknown
    }
  | {
      pluginId: string
      activation: 'catalog' | 'enabled'
      lifecycle: 'runtime'
      plugin: Plugin<unknown>
      config?: unknown
    }

export interface AgentLensIntegration {
  readonly manifest: AgentIntegrationManifest
  readonly components: readonly AgentLensIntegrationComponent[]
}

export function defineAgentLensIntegration(
  manifest: AgentIntegrationManifest,
  components: readonly AgentLensIntegrationComponent[],
): AgentLensIntegration {
  if (manifest.apiVersion !== AGENT_LENS_PLUGIN_API_VERSION) {
    throw new Error(
      `Unsupported AgentLens Integration API ${manifest.apiVersion}; expected ${AGENT_LENS_PLUGIN_API_VERSION}`,
    )
  }

  const capabilities = new Set(manifest.capabilities)
  if (capabilities.size !== manifest.capabilities.length) {
    throw new Error(`Duplicate Agent Integration capability: ${manifest.integrationId}`)
  }

  const pluginIds = new Set(manifest.componentPluginIds)
  if (pluginIds.size !== manifest.componentPluginIds.length) {
    throw new Error(`Duplicate Agent Integration component plugin id: ${manifest.integrationId}`)
  }

  const actualPluginIds = components.map(component => component.pluginId)
  if (
    actualPluginIds.length !== manifest.componentPluginIds.length
    || actualPluginIds.some((pluginId, index) => pluginId !== manifest.componentPluginIds[index])
  ) {
    throw new Error(`Agent Integration component manifest mismatch: ${manifest.integrationId}`)
  }
  for (const component of components) {
    if (component.lifecycle === 'plugin' && component.plugin.manifest.pluginId !== component.pluginId) {
      throw new Error(
        `Agent Integration component plugin id mismatch: ${component.pluginId} != ${component.plugin.manifest.pluginId}`,
      )
    }
  }

  return Object.freeze({
    manifest: Object.freeze({
      ...manifest,
      capabilities: Object.freeze([...manifest.capabilities]),
      componentPluginIds: Object.freeze([...manifest.componentPluginIds]),
    }),
    components: Object.freeze([...components]),
  })
}
