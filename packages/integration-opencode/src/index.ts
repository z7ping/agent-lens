import { defineAgentLensIntegration } from '@agent-lens/runtime-cordis'
import { openCodeSourcePlugin } from '@agent-lens/source-opencode'
import { integrationManifest } from './manifest'

export { integrationManifest as openCodeIntegrationManifest } from './manifest'

export const openCodeIntegration = defineAgentLensIntegration(
  integrationManifest,
  [
    {
      pluginId: '@agent-lens/source-opencode',
      capabilities: ['source'],
      activation: 'catalog',
      lifecycle: 'plugin',
      plugin: openCodeSourcePlugin,
    },
  ],
)

export default openCodeIntegration
