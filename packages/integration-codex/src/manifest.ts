import type { AgentIntegrationManifest } from '@agent-lens/core'

export const integrationManifest: AgentIntegrationManifest = {
  integrationId: 'codex',
  productId: 'codex',
  displayName: 'Codex',
  apiVersion: '1.0',
  capabilities: ['source', 'hook'],
  componentPluginIds: ['@agent-lens/source-codex'],
}
