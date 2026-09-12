import type { AgentIntegrationManifest } from '@agent-lens/core'
import { defineAgentLensIntegration } from '@agent-lens/runtime-cordis'
import { codexSourcePlugin } from '@agent-lens/source-codex'

export const codexIntegrationManifest: AgentIntegrationManifest = {
  integrationId: 'codex',
  productId: 'codex',
  displayName: 'Codex',
  apiVersion: '1.0',
  capabilities: ['source', 'hook'],
  componentPluginIds: ['@agent-lens/source-codex'],
}

export const codexIntegration = defineAgentLensIntegration(
  codexIntegrationManifest,
  [
    {
      pluginId: '@agent-lens/source-codex',
      capabilities: ['source'],
      activation: 'catalog',
      lifecycle: 'plugin',
      plugin: codexSourcePlugin,
    },
  ],
)
