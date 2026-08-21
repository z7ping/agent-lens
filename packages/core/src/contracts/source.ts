import type { AgentInstallation, Host } from '../domain/identity'
import type { AgentProductId, Confidence, Disposable } from '../domain/common'
import type {
  AssetDefinitionHint,
  AssetState,
} from '../domain/assets'
import type {
  EvidenceCandidate,
  NormalizedSourceOutput,
  ObservationCapability,
  SourceRecord,
} from '../domain/observation'
import type { AgentLensPluginManifest } from './plugin'

export interface SourcePluginManifest extends AgentLensPluginManifest {
  pluginType: 'source'
  sourceId: string
  productId: AgentProductId
  parserVersion: string
}

export interface SourceDetectionContext {
  host: Host
  env?: Readonly<Record<string, string | undefined>>
}

export interface DetectedSource {
  sourceId: string
  productId: AgentProductId
  executable?: string
  version?: string
  configRoot?: string
  dataRoot?: string
  confidence: Confidence
}

export interface SourceCheckpointService {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
  clear(key: string): Promise<void>
}

export interface SourceExecutionContext {
  host: Host
  installation: AgentInstallation
  abortSignal: AbortSignal
  checkpoint: SourceCheckpointService
}

export interface SourceNormalizationContext {
  host: Host
  installation: AgentInstallation
}

export interface SourceRecordEmitter {
  emit(record: SourceRecord): void | Promise<void>
}

export interface DiscoveredAssetBindingHint {
  path?: string
  source?: string
  version?: string
}

export interface DiscoveredAssetStateHint {
  state: AssetState
  value: boolean | 'unknown'
  observedAt: string
  evidenceCandidates?: EvidenceCandidate[]
}

export interface DiscoveredAsset {
  definition: AssetDefinitionHint
  binding?: DiscoveredAssetBindingHint
  states?: DiscoveredAssetStateHint[]
}

export interface SourceDefinition {
  manifest: SourcePluginManifest
  detect(ctx: SourceDetectionContext): Promise<DetectedSource[]>
  declareCapabilities(detected: DetectedSource): Promise<ObservationCapability[]>
  discoverAssets?(ctx: SourceExecutionContext): AsyncIterable<DiscoveredAsset>
  ingestHistory?(ctx: SourceExecutionContext): AsyncIterable<SourceRecord>
  startCapture?(ctx: SourceExecutionContext, emit: SourceRecordEmitter): Promise<Disposable>
  normalize(record: SourceRecord, ctx: SourceNormalizationContext): Promise<NormalizedSourceOutput>
}
