import type { AgentIntegrationManifest } from '@agent-lens/core'

export const integrationManifest: AgentIntegrationManifest = {
  integrationId: 'hermes',
  productId: 'hermes',
  displayName: 'Hermes',
  apiVersion: '1.0',
  capabilities: ['source', 'hook', 'live'],
  componentPluginIds: [
    '@agent-lens/source-hermes',
    '@agent-lens/live-hermes',
  ],
}
