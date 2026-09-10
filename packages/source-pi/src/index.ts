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
import { PI_PARSER_VERSION, PI_SOURCE_ID } from './constants'
import { normalizePiRecord } from './normalize'
import {
  detectPi,
  ingestPiHistory,
  piSessionInternals,
  startPiRuntimeCapture,
} from './session'

export async function declarePiCapabilities(
  _detected: DetectedSource,
): Promise<ObservationCapability[]> {
  return [
    { sourceId: PI_SOURCE_ID, name: 'session', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'transcript', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'tool-call', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'tool-result', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'context', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'model-change', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'thinking-level-change', status: 'available', captureModes: ['history', 'native-tail'] },
    {
      sourceId: PI_SOURCE_ID,
      name: 'asset-discovery',
      status: 'partial',
      captureModes: ['static-scan'],
      reason: 'Persisted Pi resources are resolved statically; external CLI-only and runtime extension-discovered resources require invocation/runtime evidence',
    },
    { sourceId: PI_SOURCE_ID, name: 'permission', status: 'unavailable', captureModes: [], reason: 'No stable permission event is proven in the native session log' },
    { sourceId: PI_SOURCE_ID, name: 'subagent', status: 'partial', captureModes: ['history'], reason: 'Parent session links are retained; explicit subagent lifecycle is not proven' },
    { sourceId: PI_SOURCE_ID, name: 'thinking', status: 'partial', captureModes: ['history'], reason: 'Only source-visible thinking blocks are captured' },
    { sourceId: PI_SOURCE_ID, name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: 'Invocation attribution is handled by later usage projections' },
    { sourceId: PI_SOURCE_ID, name: 'usage', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'artifact-action', status: 'unavailable', captureModes: [], reason: 'Artifact attribution is not implemented' },
  ]
}

export const piManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-pi',
  pluginVersion: '1.0.0-alpha.5',
  apiVersion: '1.0',
  pluginType: 'source',
  displayName: 'Pi Source',
  sourceId: PI_SOURCE_ID,
  productId: PI_SOURCE_ID,
  parserVersion: PI_PARSER_VERSION,
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
