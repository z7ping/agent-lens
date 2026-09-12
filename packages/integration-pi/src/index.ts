import {
  defineAgentLensIntegration,
  piLiveRuntimePlugin,
} from '@agent-lens/runtime-cordis'
import { piSourcePlugin } from '@agent-lens/source-pi'
import { integrationManifest } from './manifest'

export { integrationManifest as piIntegrationManifest } from './manifest'

export const piIntegration = defineAgentLensIntegration(
  integrationManifest,
  [
    { pluginId: '@agent-lens/source-pi', capabilities: ['source'], activation: 'catalog', lifecycle: 'plugin', plugin: piSourcePlugin },
    { pluginId: '@agent-lens/runtime-cordis/pi-live', capabilities: ['runtime', 'live'], authorization: 'explicit', activation: 'enabled', lifecycle: 'runtime', plugin: piLiveRuntimePlugin },
  ],
)

export default piIntegration
