import {
  defineAgentLensPlugin,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import '@agent-lens/surface-http'

export interface WebPluginConfig {
  staticDir: string
}

const manifest = {
  pluginId: '@agent-lens/web',
  pluginVersion: '1.0.0-alpha.2',
  apiVersion: '1.0',
  pluginType: 'surface',
  displayName: 'AgentLens Web',
} as const

const applyWeb = Object.assign(
  (ctx: AgentLensContext, config: WebPluginConfig) => {
    if (!config?.staticDir) throw new Error('AgentLens Web requires a static directory')
    const mount = ctx.http.mountStatic({
      id: '@agent-lens/web',
      directory: config.staticDir,
      spaFallback: true,
    })
    return () => mount.dispose()
  },
  { inject: ['http'] },
)

export const webPlugin = defineAgentLensPlugin(manifest, applyWeb)
