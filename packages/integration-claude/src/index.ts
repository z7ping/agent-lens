import type { AgentIntegrationManifest } from '@agent-lens/core'
import { defineAgentLensIntegration } from '@agent-lens/runtime-cordis'
import { claudeSourcePlugin } from '@agent-lens/source-claude'

export const claudeIntegrationManifest: AgentIntegrationManifest = {
  integrationId: 'claude-code',
  productId: 'claude-code',
  displayName: 'Claude Code',
  apiVersion: '1.0',
  capabilities: ['source', 'hook'],
  componentPluginIds: ['@agent-lens/source-claude'],
}

export const claudeIntegration = defineAgentLensIntegration(
  claudeIntegrationManifest,
  [
    {
      pluginId: '@agent-lens/source-claude',
      capabilities: ['source'],
      activation: 'catalog',
      lifecycle: 'plugin',
      plugin: claudeSourcePlugin,
    },
  ],
)

export default claudeIntegration
