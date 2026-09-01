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
import { discoverCodexAssets } from './assets'
import { detectCodex } from './detect'
import { ingestCodexHistory } from './history'
import { normalizeCodexRecordWithVisibleReasoning } from './normalize-visible-reasoning'
import { startCodexRuntimeCapture } from './runtime'

export const codexManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-codex',
  pluginVersion: '1.0.0-alpha.2',
  apiVersion: '1.0',
  pluginType: 'source',
  displayName: 'Codex Source',
  sourceId: 'codex',
  productId: 'codex',
  parserVersion: '6',
}

export async function declareCodexCapabilities(
  _detected: DetectedSource,
): Promise<ObservationCapability[]> {
  return [
    { sourceId: 'codex', name: 'session', status: 'available', captureModes: ['history', 'runtime-hook'] },
    { sourceId: 'codex', name: 'transcript', status: 'available', captureModes: ['history'] },
    { sourceId: 'codex', name: 'tool-call', status: 'available', captureModes: ['history', 'runtime-hook'] },
    { sourceId: 'codex', name: 'tool-result', status: 'available', captureModes: ['history', 'runtime-hook'] },
    { sourceId: 'codex', name: 'permission', status: 'available', captureModes: ['runtime-hook'] },
    { sourceId: 'codex', name: 'subagent', status: 'available', captureModes: ['runtime-hook'] },
    { sourceId: 'codex', name: 'usage', status: 'available', captureModes: ['history'] },
    { sourceId: 'codex', name: 'context', status: 'available', captureModes: ['history', 'runtime-hook'] },
    { sourceId: 'codex', name: 'asset-discovery', status: 'available', captureModes: ['static-scan'] },
    { sourceId: 'codex', name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: 'Asset invocation attribution is not yet implemented' },
    { sourceId: 'codex', name: 'thinking', status: 'partial', captureModes: ['history'], reason: 'Only source-visible reasoning records can be observed' },
    { sourceId: 'codex', name: 'artifact-action', status: 'unavailable', captureModes: [], reason: 'Artifact attribution is not yet implemented' },
  ]
}

export const codexSourceDefinition: SourceDefinition = {
  manifest: codexManifest,
  detect: detectCodex,
  declareCapabilities: declareCodexCapabilities,
  discoverAssets: discoverCodexAssets,
  ingestHistory: ingestCodexHistory,
  startCapture: startCodexRuntimeCapture,
  normalize: normalizeCodexRecordWithVisibleReasoning,
}

const applyCodexSource = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.sources.register(codexSourceDefinition)
    return () => registration.dispose()
  },
  { inject: ['sources'] },
)

export const codexSourcePlugin = defineAgentLensPlugin(codexManifest, applyCodexSource)

export * from './assets'
export * from './detect'
export * from './format'
export * from './history'
export * from './normalize'
export * from './normalize-visible-reasoning'
export * from './runtime'
