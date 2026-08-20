import {
  defineAgentLensPlugin,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import {
  DEFAULT_AGENT_LENS_HTTP_PORT,
  startHttpSurface,
} from './server'

export interface HttpSurfacePluginConfig {
  port?: number
  staticDir?: string
}

const manifest = {
  pluginId: '@agent-lens/surface-http',
  pluginVersion: '1.0.0-alpha.0',
  apiVersion: '1.0',
  pluginType: 'surface',
  displayName: 'AgentLens HTTP Surface',
} as const

const applyHttpSurface = Object.assign(
  async (ctx: AgentLensContext, config: HttpSurfacePluginConfig = {}) => {
    const surface = await startHttpSurface(ctx.storage, {
      port: config.port ?? DEFAULT_AGENT_LENS_HTTP_PORT,
      ...(config.staticDir ? { staticDir: config.staticDir } : {}),
    })
    return () => surface.dispose()
  },
  { inject: ['storage'] },
)

export const httpSurfacePlugin = defineAgentLensPlugin(manifest, applyHttpSurface)
