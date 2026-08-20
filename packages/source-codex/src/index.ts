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
import { detectCodex } from './detect'
import { ingestCodexHistory } from './history'
import { normalizeCodexRecord } from './normalize'

export const codexManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-codex',
  pluginVersion: '1.0.0-alpha.0',
  apiVersion: '1.0',
  pluginType: 'source',
  displayName: 'Codex Source',
  sourceId: 'codex',
  productId: 'codex',
  parserVersion: '1',
}

export async function declareCodexCapabilities(
  _detected: DetectedSource,
): Promise<ObservationCapability[]> {
  return [
    { sourceId: 'codex', name: 'session', status: 'available', captureModes: ['history'] },
    { sourceId: 'codex', name: 'transcript', status: 'available', captureModes: ['history'] },
    { sourceId: 'codex', name: 'tool-call', status: 'available', captureModes: ['history'] },
    { sourceId: 'codex', name: 'tool-result', status: 'available', captureModes: ['history'] },
    { sourceId: 'codex', name: 'permission', status: 'unavailable', captureModes: [], reason: 'Not mapped by the initial history parser' },
    { sourceId: 'codex', name: 'subagent', status: 'unavailable', captureModes: [], reason: 'Not mapped by the initial history parser' },
    { sourceId: 'codex', name: 'usage', status: 'unavailable', captureModes: [], reason: 'Not mapped by the initial history parser' },
    { sourceId: 'codex', name: 'context', status: 'unavailable', captureModes: [], reason: 'Model context exposure is not proven by rollout history' },
    { sourceId: 'codex', name: 'asset-discovery', status: 'unavailable', captureModes: [], reason: 'Static asset discovery is a later Codex phase' },
    { sourceId: 'codex', name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: 'Asset invocation attribution is not yet implemented' },
    { sourceId: 'codex', name: 'thinking', status: 'partial', captureModes: ['history'], reason: 'Only source-visible reasoning records can be observed' },
    { sourceId: 'codex', name: 'artifact-action', status: 'unavailable', captureModes: [], reason: 'Artifact attribution is not yet implemented' },
  ]
}

export const codexSourceDefinition: SourceDefinition = {
  manifest: codexManifest,
  detect: detectCodex,
  declareCapabilities: declareCodexCapabilities,
  ingestHistory: ingestCodexHistory,
  normalize: normalizeCodexRecord,
}

const applyCodexSource = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.sources.register(codexSourceDefinition)
    return () => registration.dispose()
  },
  { inject: ['sources'] },
)

export const codexSourcePlugin = defineAgentLensPlugin(codexManifest, applyCodexSource)

export * from './detect'
export * from './format'
export * from './history'
export * from './normalize'
