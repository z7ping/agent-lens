export type AgentLensPluginType = 'source' | 'analyzer' | 'storage' | 'surface'

/**
 * AgentLens business metadata only.
 * Plugin loading/lifecycle belongs to Cordis; this is not a second plugin runtime contract.
 */
export interface AgentLensPluginManifest {
  pluginId: string
  pluginVersion: string
  apiVersion: string
  pluginType: AgentLensPluginType
  displayName: string
  capabilities?: string[]
}
