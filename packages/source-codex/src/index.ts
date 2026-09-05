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
import {
  CODEX_CURRENT_PARSER_VERSION,
  normalizeCurrentCodexRecord,
} from './current-protocol'
import { detectCodex } from './detect'
import { ingestCodexHistory } from './history'
import { startCodexRuntimeCapture } from './runtime'
import { normalizeCodexSessionAttribution } from './session-attribution'

export const codexManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-codex',
  pluginVersion: '1.0.0-alpha.2',
  apiVersion: '1.0',
  pluginType: 'source',
  displayName: 'Codex Source',
  sourceId: 'codex',
  productId: 'codex',
  parserVersion: CODEX_CURRENT_PARSER_VERSION,
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

const ingestCurrentCodexHistory: NonNullable<SourceDefinition['ingestHistory']> = async function* (ctx) {
  for await (const record of ingestCodexHistory(ctx)) {
    yield record.parserVersion === CODEX_CURRENT_PARSER_VERSION
      ? record
      : { ...record, parserVersion: CODEX_CURRENT_PARSER_VERSION }
  }
}

export const codexSourceDefinition: SourceDefinition = {
  manifest: codexManifest,
  detect: detectCodex,
  declareCapabilities: declareCodexCapabilities,
  discoverAssets: discoverCodexAssets,
  ingestHistory: ingestCurrentCodexHistory,
  startCapture: startCodexRuntimeCapture,
  normalize: async (record, ctx) => normalizeCodexSessionAttribution(
    record,
    ctx,
    await normalizeCurrentCodexRecord(record, ctx),
  ),
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
export * from './current-protocol'
export * from './detect'
export * from './format'
export * from './history'
export * from './normalize'
export * from './runtime'
export * from './session-attribution'
