import type { AgentIntegrationManifest } from '@agent-lens/core'
import { defineAgentLensIntegration } from '@agent-lens/runtime-cordis'
import { openCodeSourcePlugin } from '@agent-lens/source-opencode'

export const openCodeIntegrationManifest: AgentIntegrationManifest = {
  integrationId: 'opencode',
  productId: 'opencode',
  displayName: 'OpenCode',
  apiVersion: '1.0',
  capabilities: ['source'],
  componentPluginIds: ['@agent-lens/source-opencode'],
}

export const openCodeIntegration = defineAgentLensIntegration(
  openCodeIntegrationManifest,
  [
    {
      pluginId: '@agent-lens/source-opencode',
      activation: 'catalog',
      lifecycle: 'plugin',
      plugin: openCodeSourcePlugin,
    },
  ],
)
