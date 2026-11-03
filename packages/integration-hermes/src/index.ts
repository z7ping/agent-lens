import { hermesLivePlugin } from '@agent-lens/live-hermes'
import { defineAgentLensIntegration } from '@agent-lens/runtime-cordis'
import { hermesSourcePlugin } from '@agent-lens/source-hermes'
import { integrationManifest } from './manifest'

export { integrationManifest as hermesIntegrationManifest } from './manifest'
export { readHermesWorkspace } from './workspace.js'
export { mutateHermesWorkspace, hermesWorkMutationArgv } from './workspace-actions.js'
export { readHermesCronOutput } from './cron-output.js'

export const hermesIntegration = defineAgentLensIntegration(
  integrationManifest,
  [
    { pluginId: '@agent-lens/source-hermes', capabilities: ['source', 'assets'], activation: 'catalog', lifecycle: 'plugin', plugin: hermesSourcePlugin },
    { pluginId: '@agent-lens/live-hermes', capabilities: ['live'], authorization: 'explicit', activation: 'enabled', lifecycle: 'plugin', plugin: hermesLivePlugin },
  ],
)

export default hermesIntegration
