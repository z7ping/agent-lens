import type { AgentIntegrationManifest } from '@agent-lens/core'

export const integrationManifest: AgentIntegrationManifest = {
  integrationId: 'pi',
  productId: 'pi',
  displayName: 'Pi',
  apiVersion: '1.0',
  capabilities: ['source', 'runtime', 'live', 'assets'],
  componentPluginIds: [
    '@agent-lens/source-pi',
    '@agent-lens/runtime-cordis/pi-live',
  ],
}
