import type { AgentIntegrationManifest } from '@agent-lens/core'
import {
  defineAgentLensIntegration,
  piLiveRuntimePlugin,
} from '@agent-lens/runtime-cordis'
import { piSourcePlugin } from '@agent-lens/source-pi'

export const piIntegrationManifest: AgentIntegrationManifest = {
  integrationId: 'pi',
  productId: 'pi',
  displayName: 'Pi',
  apiVersion: '1.0',
  capabilities: ['source', 'runtime', 'live'],
  componentPluginIds: [
    '@agent-lens/source-pi',
    '@agent-lens/runtime-cordis/pi-live',
  ],
}

export const piIntegration = defineAgentLensIntegration(
  piIntegrationManifest,
  [
    { pluginId: '@agent-lens/source-pi', capabilities: ['source'], activation: 'catalog', lifecycle: 'plugin', plugin: piSourcePlugin },
    { pluginId: '@agent-lens/runtime-cordis/pi-live', capabilities: ['runtime', 'live'], authorization: 'explicit', activation: 'enabled', lifecycle: 'runtime', plugin: piLiveRuntimePlugin },
  ],
)

export default piIntegration
