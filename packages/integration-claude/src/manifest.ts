import type { AgentIntegrationManifest } from '@agent-lens/core'

export const integrationManifest: AgentIntegrationManifest = {
  integrationId: 'claude-code',
  productId: 'claude-code',
  displayName: 'Claude Code',
  apiVersion: '1.0',
  capabilities: ['source', 'hook', 'assets'],
  componentPluginIds: ['@agent-lens/source-claude'],
}
