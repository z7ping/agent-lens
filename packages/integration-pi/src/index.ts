import {
  defineAgentLensIntegration,
  piLiveRuntimePlugin,
} from '@agent-lens/runtime-cordis'
import { piSourcePlugin } from '@agent-lens/source-pi'
import { piEcosystemPlugin } from './ecosystem'
import { integrationManifest } from './manifest'

export { NpmPiEcosystemProvider, piEcosystemInternals } from './ecosystem'
export { integrationManifest as piIntegrationManifest } from './manifest'

export const piIntegration = defineAgentLensIntegration(
  integrationManifest,
  [
    { pluginId: '@agent-lens/source-pi', capabilities: ['source', 'assets'], activation: 'catalog', lifecycle: 'plugin', plugin: piSourcePlugin },
    { pluginId: '@agent-lens/runtime-cordis/pi-live', capabilities: ['runtime', 'live'], authorization: 'explicit', activation: 'enabled', lifecycle: 'runtime', plugin: piLiveRuntimePlugin },
    { pluginId: '@agent-lens/integration-pi/ecosystem', capabilities: [], activation: 'enabled', lifecycle: 'runtime', plugin: piEcosystemPlugin },
  ],
)

export default piIntegration
