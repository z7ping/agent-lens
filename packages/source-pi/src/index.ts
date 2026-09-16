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
import { verifyJsonlLineSha256 } from '@agent-lens/source-support'
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

const jsonlRawRecovery: NonNullable<SourceDefinition['rawRecovery']> = {
  describe(record) {
    const stable = record.locator.kind === 'file'
      && Boolean(record.locator.path)
      && record.locator.offset !== undefined
      && Boolean(record.fingerprint)
    return stable
      ? {
          authority: 'native-store',
          locatorStability: 'stable',
          mutability: 'append-oriented',
          verification: 'fingerprint',
          canReread: true,
          canReparse: true,
          replayable: true,
          persistencePreference: 'reference',
        }
      : {
          authority: record.locator.kind === 'runtime-hook' ? 'agent-lens-only' : 'unknown',
          locatorStability: 'none',
          mutability: record.locator.kind === 'runtime-hook' ? 'ephemeral' : 'unknown',
          verification: 'none',
          canReread: false,
          canReparse: false,
          replayable: false,
          persistencePreference: 'preserve',
          reason: record.locator.kind === 'runtime-hook'
            ? 'runtime-hook source is consumed from an ephemeral inbox'
            : 'record does not expose a stable JSONL path+offset+fingerprint locator',
        }
  },
  async verify(record) {
    const result = await verifyJsonlLineSha256({
      path: record.locator.path,
      offset: record.locator.offset,
      expectedFingerprint: record.fingerprint,
    })
    return {
      ...result,
      checkedAt: new Date().toISOString(),
    }
  },
}

export const piSourceDefinition: SourceDefinition = {
  manifest: piManifest,
  detect: detectPi,
  declareCapabilities: declarePiCapabilities,
  rawRecovery: jsonlRawRecovery,
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
