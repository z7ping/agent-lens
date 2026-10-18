import { defineAgentLensIntegration } from '@agent-lens/runtime-cordis'
import { codexSourcePlugin } from '@agent-lens/source-codex'
import { codexLivePlugin } from '@agent-lens/live-codex'
import { integrationManifest } from './manifest'

export { integrationManifest as codexIntegrationManifest } from './manifest'

export const codexIntegration = defineAgentLensIntegration(
  integrationManifest,
  [
    {
      pluginId: '@agent-lens/source-codex',
      capabilities: ['source', 'assets'],
      activation: 'catalog',
      lifecycle: 'plugin',
      plugin: codexSourcePlugin,
    },
    {
      pluginId: '@agent-lens/live-codex',
      capabilities: ['live'],
      authorization: 'explicit',
      activation: 'enabled',
      lifecycle: 'plugin',
      plugin: codexLivePlugin,
    },
  ],
)

export default codexIntegration
