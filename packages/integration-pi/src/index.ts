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
    { lifecycle: 'plugin', plugin: piSourcePlugin },
    { lifecycle: 'runtime', plugin: piLiveRuntimePlugin },
  ],
)
