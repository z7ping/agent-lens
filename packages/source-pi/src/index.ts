import type {
  DetectedSource,
  ObservationCapability,
  SourceDefinition,
  SourcePluginManifest,
} from '@agent-lens/core'
import {
  defineAgentLensPlugin,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import { discoverPiAssets, piAssetInternals } from './assets'
import { normalizePiRecord } from './normalize'
import {
  detectPi,
  ingestPiHistory,
  piSessionInternals,
  startPiRuntimeCapture,
} from './session'

const SOURCE_ID = 'pi'
const PARSER_VERSION = '7'

export async function declarePiCapabilities(
  _detected: DetectedSource,
): Promise<ObservationCapability[]> {
  return [
    { sourceId: SOURCE_ID, name: 'session', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'transcript', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'tool-call', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'tool-result', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'context', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'model-change', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'thinking-level-change', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'asset-discovery', status: 'available', captureModes: ['static-scan'] },
    { sourceId: SOURCE_ID, name: 'permission', status: 'unavailable', captureModes: [], reason: 'No stable permission event is proven in the native session log' },
    { sourceId: SOURCE_ID, name: 'subagent', status: 'partial', captureModes: ['history'], reason: 'Parent session links are retained; explicit subagent lifecycle is not proven' },
    { sourceId: SOURCE_ID, name: 'thinking', status: 'partial', captureModes: ['history'], reason: 'Only source-visible thinking blocks are captured' },
    { sourceId: SOURCE_ID, name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: 'Invocation attribution is handled by later usage projections' },
    { sourceId: SOURCE_ID, name: 'usage', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'artifact-action', status: 'unavailable', captureModes: [], reason: 'Artifact attribution is not implemented' },
  ]
}

export const piManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-pi',
  pluginVersion: '1.0.0-alpha.5',
  apiVersion: '1.0',
  pluginType: 'source',
  displayName: 'Pi Source',
  sourceId: SOURCE_ID,
  productId: SOURCE_ID,
  parserVersion: PARSER_VERSION,
}

export const piSourceDefinition: SourceDefinition = {
  manifest: piManifest,
  detect: detectPi,
  declareCapabilities: declarePiCapabilities,
  discoverAssets: discoverPiAssets,
  ingestHistory: ingestPiHistory,
  startCapture: startPiRuntimeCapture,
  normalize: normalizePiRecord,
}

const applyPiSource = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.sources.register(piSourceDefinition)
    return () => registration.dispose()
  },
  { inject: ['sources'] },
)

export const piSourcePlugin = defineAgentLensPlugin(piManifest, applyPiSource)

export {
  detectPi,
  discoverPiAssets,
  ingestPiHistory,
  normalizePiRecord,
  startPiRuntimeCapture,
}

export const piInternals = {
  ...piSessionInternals,
  ...piAssetInternals,
}
