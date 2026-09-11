import type { AgentIntegrationManifest } from '@agent-lens/core'
import { hermesLivePlugin } from '@agent-lens/live-hermes'
import { defineAgentLensIntegration } from '@agent-lens/runtime-cordis'
import { hermesSourcePlugin } from '@agent-lens/source-hermes'

export const hermesIntegrationManifest: AgentIntegrationManifest = {
  integrationId: 'hermes',
  productId: 'hermes',
  displayName: 'Hermes',
  apiVersion: '1.0',
  capabilities: ['source', 'hook', 'live', 'assets'],
  componentPluginIds: [
    '@agent-lens/source-hermes',
    '@agent-lens/live-hermes',
  ],
}

export const hermesIntegration = defineAgentLensIntegration(
  hermesIntegrationManifest,
  [
    { pluginId: '@agent-lens/source-hermes', capabilities: ['source', 'assets'], activation: 'catalog', lifecycle: 'plugin', plugin: hermesSourcePlugin },
    { pluginId: '@agent-lens/live-hermes', capabilities: ['live'], authorization: 'explicit', activation: 'enabled', lifecycle: 'plugin', plugin: hermesLivePlugin },
  ],
)

export default hermesIntegration
