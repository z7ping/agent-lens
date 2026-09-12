import { defineAgentLensIntegration } from '@agent-lens/runtime-cordis'
import { claudeSourcePlugin } from '@agent-lens/source-claude'
import { integrationManifest } from './manifest'

export { integrationManifest as claudeIntegrationManifest } from './manifest'

export const claudeIntegration = defineAgentLensIntegration(
  integrationManifest,
  [
    {
      pluginId: '@agent-lens/source-claude',
      capabilities: ['source', 'assets'],
      activation: 'catalog',
      lifecycle: 'plugin',
      plugin: claudeSourcePlugin,
    },
  ],
)

export default claudeIntegration
