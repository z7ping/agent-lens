import type { AgentInstallation, Host, RuntimeProfile } from '../domain/identity'
import type { AgentProductId, Confidence, Disposable } from '../domain/common'
import type {
  AssetDefinitionHint,
  AssetScope,
  AssetState,
} from '../domain/assets'
import type {
  EvidenceCandidate,
  NormalizedSourceOutput,
  ObservationCapability,
  SourceRecord,
} from '../domain/observation'
import type { AgentLensPluginManifest } from './plugin'
import type { SourceHistoryProgressUpdate } from '../domain/diagnostics'
import type { NativeSessionCatalogEntry } from '../services/native-session-catalog'

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

export interface DetectedRuntimeProfile {
  nativeProfileId: string
  name?: string
  configRoot?: string
  dataRoot?: string
}

export interface DetectedSource {
  sourceId: string
  productId: AgentProductId
  executable?: string
  version?: string
  configRoot?: string
  dataRoot?: string
  runtimeProfile?: DetectedRuntimeProfile
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
  runtimeProfile?: RuntimeProfile
  abortSignal: AbortSignal
  checkpoint: SourceCheckpointService
}

export interface SourceHistoryWindow {
  /** 只调度最后活动时间不早于该时刻的历史单元。 */
  activeSince?: string
  /** 按最后活动时间倒序处理的最大历史会话数。 */
  sessionLimit?: number
}

export interface SourceHistoryExecutionContext extends SourceExecutionContext {
  historyWindow?: SourceHistoryWindow
  /** Only trusted, source-enumerated native paths already claimed native-only.
   * A path is safe to skip only when it contains ONE session (JSONL), never
   * when several independently claimed sessions share a mutable SQLite DB.
   */
  skipNativeSessionFile?: (filePath: string) => boolean
  /** Durable Source-native session IDs with verified Native-only ownership.
   * Sources sharing one SQLite database must skip ONLY these sessions while
   * retaining Legacy rows from the same physical database file.
   */
  skipNativeSessionId?: (nativeSessionId: string) => boolean
  /** 来源只报告真实工作节点；由共享 Runner 节流并持久化。 */
  reportProgress?(update: SourceHistoryProgressUpdate): Promise<void>
}

export interface SourceNormalizationContext {
  host: Host
  installation: AgentInstallation
  runtimeProfile?: RuntimeProfile
}

export interface SourceRecordEmitter {
  emit(record: SourceRecord): void | Promise<void>
}

export type SourceRawAuthority =
  | 'native-store'
  | 'agent-lens-only'
  | 'unknown'

export type SourceRawMutability =
  | 'append-oriented'
  | 'mutable'
  | 'ephemeral'
  | 'unknown'

export type SourceRawLocatorStability =
  | 'stable'
  | 'best-effort'
  | 'none'
  | 'unknown'

export type SourceRawVerification =
  | 'fingerprint'
  | 'identity-only'
  | 'none'
  | 'unknown'

export type SourceRawPersistencePreference =
  | 'reference'
  | 'inline'
  | 'blob'
  | 'preserve'

export interface SourceRawRecoveryCapability {
  authority: SourceRawAuthority
  locatorStability: SourceRawLocatorStability
  mutability: SourceRawMutability
  verification: SourceRawVerification
  canReread: boolean
  canReparse: boolean
  replayable: boolean
  persistencePreference: SourceRawPersistencePreference
  /** A mutable native database can be the authority for the CURRENT session
   * state without promising that overwritten/deleted prior row versions remain.
   * Must be explicitly declared for Source-native, session-scoped replay;
   * an ordinary best-effort rowId is never sufficient for Native-only.
   */
  recoveryScope?: 'record-immutable' | 'session-current-state'
  reason?: string
}

export type SourceRawRecoveryState =
  | 'verified'
  | 'preserved'
  | 'unavailable'
  | 'drifted'
  | 'unsupported'
  | 'unknown'

export interface SourceRawRecoveryCheck {
  state: SourceRawRecoveryState
  checkedAt: string
  currentFingerprint?: string
  reason?: string
}

export interface SourceRawRecoveryContext extends SourceExecutionContext {}

/**
 * Native-only transient hydration. A successful SourceRecord has its payload
 * in memory for the existing normalizer; it MUST NOT be passed to ingestion
 * or persisted as an independent content copy.
 */
export type SourceRawHydrationResult =
  | { state: 'available'; record: SourceRecord }
  | { state: 'unavailable' | 'drifted' | 'pending' | 'unsupported' | 'incompatible'; reason: string; currentFingerprint?: string }

export interface SourceRawRecoveryPolicy {
  describe(record: SourceRecord): SourceRawRecoveryCapability
  verify?(
    record: SourceRecord,
    ctx?: SourceRawRecoveryContext,
  ): Promise<SourceRawRecoveryCheck>
  /** Source-controlled, authorized read. Never accepts an arbitrary browser path. */
  hydrate?(record: SourceRecord, ctx: SourceRawRecoveryContext): Promise<SourceRawHydrationResult>
}


export interface DiscoveredAssetBindingHint {
  runtimeProfileId?: string
  scope?: AssetScope
  scopeRoot?: string
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

/**
 * Native session windows are read-only and transient. filePath MUST come from a
 * trusted local Session Catalog, never from raw HTTP or an untrusted client.
 * Unlike ingestHistory this never advances a checkpoint or persists facts.
 */
export interface SourceNativeSessionCursor {
  offset: number
  sequence: number
  fileIdentity: string
  /** Optional source-owned boundary proof: JSONL preceding 256 bytes, or a verified SQLite row fingerprint. */
  boundaryHash?: string
  /** Optional SHA-256 of the original bounded physical JSONL record text.
   * Kept with the Source cursor only; never a copy of the event payload. */
  recordFingerprint?: string
}

export interface SourceNativeSessionPageQuery {
  filePath: string
  nativeSessionId: string
  cursor?: SourceNativeSessionCursor
  limit?: number
}

export type SourceNativeSessionPageResult =
  | {
      state: 'available'
      records: SourceRecord[]
      /** Per-record rewind point: exact byte start and preceding physical line count. */
      recordCursors?: SourceNativeSessionCursor[]
      nextCursor: SourceNativeSessionCursor
      hasMore: boolean
      pendingTail: boolean
    }
  | { state: 'unavailable' | 'drifted' | 'unsupported'; reason: string }

export interface SourceDefinition {
  manifest: SourcePluginManifest
  detect(ctx: SourceDetectionContext): Promise<DetectedSource[]>
  declareCapabilities(detected: DetectedSource): Promise<ObservationCapability[]>
  discoverAssets?(ctx: SourceExecutionContext): AsyncIterable<DiscoveredAsset>
  /** Read only native session file headers + stat; no SourceRecord, normalize or replay. */
  discoverNativeSessions?(ctx: SourceHistoryExecutionContext): AsyncIterable<NativeSessionCatalogEntry>
  ingestHistory?(ctx: SourceHistoryExecutionContext): AsyncIterable<SourceRecord>
  startCapture?(ctx: SourceExecutionContext, emit: SourceRecordEmitter): Promise<Disposable>
  rawRecovery?: SourceRawRecoveryPolicy
  readNativeSessionPage?(query: SourceNativeSessionPageQuery, ctx: SourceExecutionContext): Promise<SourceNativeSessionPageResult>
  /** Explicit attestation that all durable per-session history and runtime facts
   * can be reconstructed from the original source store. Defaults to false.
   * Sources with transient runtime-hook-only facts must not set this until a
   * separate nonduplicate sidecar has its own verified read/recovery path.
   * Mutable SQLite may cover the current Source-owned session snapshot only
   * if rawRecovery explicitly reports recoveryScope=session-current-state.
   * Overwritten/deleted prior row revisions are NOT promised by Scheme B.
   */
  nativeSessionCoverageComplete?: boolean
  /** Read source-owned, per-session original Hook inbox archives only. Caller
   * never supplies a file path. Optional until source/runtime recovery is
   * integrated with the shared native TaskSurface projection.
   */
  readArchivedNativeHooks?(nativeSessionId: string, ctx: SourceExecutionContext): Promise<SourceRecord[]>
  /** Paged single-copy Hook archive reader. The cursor is Source-owned,
   * session-bound and never a filesystem path or a persisted event payload.
   */
  readArchivedNativeHooksPage?(nativeSessionId: string, ctx: SourceExecutionContext, cursor?: string):
    Promise<{ records: SourceRecord[]; hasMore: boolean; nextCursor?: string }>
  normalize(record: SourceRecord, ctx: SourceNormalizationContext): Promise<NormalizedSourceOutput>
}
