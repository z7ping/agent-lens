import { defineAgentLensIntegration } from '@agent-lens/runtime-cordis'
import { profiledDshSourcePlugin } from '@agent-lens/source-dsh'
import { integrationManifest } from './manifest'

export { integrationManifest as dshIntegrationManifest } from './manifest'

export const dshIntegration = defineAgentLensIntegration(
  integrationManifest,
  [
    {
      pluginId: '@agent-lens/source-dsh',
      capabilities: ['source', 'assets'],
      activation: 'catalog',
      lifecycle: 'plugin',
      plugin: profiledDshSourcePlugin,
    },
  ],
)

export default dshIntegration
