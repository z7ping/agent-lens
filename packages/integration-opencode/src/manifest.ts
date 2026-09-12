import type { AgentIntegrationManifest } from '@agent-lens/core'

export const integrationManifest: AgentIntegrationManifest = {
  integrationId: 'opencode',
  productId: 'opencode',
  displayName: 'OpenCode',
  apiVersion: '1.0',
  capabilities: ['source'],
  componentPluginIds: ['@agent-lens/source-opencode'],
}
