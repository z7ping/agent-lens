import { defineAgentLensIntegration } from '@agent-lens/runtime-cordis'
import { codexSourcePlugin } from '@agent-lens/source-codex'
import { integrationManifest } from './manifest'

export { integrationManifest as codexIntegrationManifest } from './manifest'

export const codexIntegration = defineAgentLensIntegration(
  integrationManifest,
  [
    {
      pluginId: '@agent-lens/source-codex',
      capabilities: ['source'],
      activation: 'catalog',
      lifecycle: 'plugin',
      plugin: codexSourcePlugin,
    },
  ],
)

export default codexIntegration
