import type { AgentIntegrationManifest } from '@agent-lens/core'

export const integrationManifest: AgentIntegrationManifest = {
  integrationId: 'dsh',
  productId: 'dsh',
  displayName: 'DeepSeek Harness',
  apiVersion: '1.0',
  capabilities: ['source', 'assets'],
  componentPluginIds: ['@agent-lens/source-dsh'],
}
