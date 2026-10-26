import type {
  AgentInstallation,
  AssetService,
  AssetState,
  CapabilityService,
  CapturePolicyService,
  CoverageService,
  DetectedSource,
  Disposable,
  EvidenceCandidate,
  EvidenceService,
  Host,
  IdentityService,
  ObservationService,
  RuntimeProfile,
  SessionRelationshipCandidate,
  SourceCheckpointService,
  SourceDefinition,
  SourceHistoryWindow,
  SourceRecord,
  SourceRecordReplayCursor,
  SourceRuntimeStatus,
  StorageService,
  VersionedCheckpoint,
} from '@agent-lens/core'
import { materializeEvidence } from './index'
import { NativeSessionCatalogTracker } from './native-session-catalog-tracker'
import { NativeOnlySourceIndexer } from './native-only-source-indexer'
import { deriveParentRelationshipCandidates } from './relationship-hints'
import { queuedHistoryStatus, SourceHistoryProgressTracker } from './source-history-progress'

const DEFAULT_COOPERATIVE_BUDGET_MS = 8
const PARSER_REPLAY_TRANSACTION_SIZE = 50
const PARSER_REPLAY_TRANSACTION_BUDGET_MS = 20
const PARSER_REPLAY_CHECKPOINT_SCOPE = 'parser-replay'
const ASSET_DISCOVERY_SNAPSHOT_KEY = 'asset-discovery-inventory-v1'
const ASSET_INVENTORY_STATES = new Set<AssetState>(['installed', 'configured'])
const ASSET_PRESENCE_STATES = new Set<AssetState>(['installed', 'configured', 'enabled', 'discoverable', 'exposed'])

interface CooperativeSchedulerOptions {
  budgetMs?: number
  now?: () => number
  yieldControl?: () => Promise<void>
}

interface ParserReplayCheckpoint {
  sourceId: string
  installationId: string
  targetParserVersion: string
  window: string
  state: 'pending' | 'running' | 'completed'
  dirty: boolean
  cursor?: SourceRecordReplayCursor
  updatedAt: string
  completedAt?: string
}

interface AssetDiscoverySnapshot {
  bindings: Record<string, AssetState[]>
  completedAt: string
}

async function readReplayCheckpoint(
  storage: StorageService,
  key: string,
): Promise<VersionedCheckpoint<ParserReplayCheckpoint> | null> {
  if (!storage.checkpoints.getWithRevision) {
    throw new Error('Parser Replay requires versioned checkpoint storage')
  }
  return storage.checkpoints.getWithRevision<ParserReplayCheckpoint>(PARSER_REPLAY_CHECKPOINT_SCOPE, key)
}

async function compareAndSetReplayCheckpoint(
  storage: StorageService,
  key: string,
  expectedRevision: number | null,
  value: ParserReplayCheckpoint,
): Promise<boolean> {
  if (!storage.checkpoints.compareAndSet) {
    throw new Error('Parser Replay requires compare-and-set checkpoint storage')
  }
  return storage.checkpoints.compareAndSet(
    PARSER_REPLAY_CHECKPOINT_SCOPE,
    key,
    expectedRevision,
    value,
  )
}

function createCooperativeScheduler(options: CooperativeSchedulerOptions = {}) {
  const budgetMs = options.budgetMs ?? DEFAULT_COOPERATIVE_BUDGET_MS
  const now = options.now ?? Date.now
  const yieldControl = options.yieldControl
    ?? (() => new Promise<void>(resolve => setImmediate(resolve)))
  let deadline = now() + budgetMs

  return async (): Promise<boolean> => {
    if (now() < deadline) return false
    await yieldControl()
    deadline = now() + budgetMs
    return true
  }
}

function parserReplayTransactionExpired(
  startedAt: number,
  processed: number,
  now: () => number = Date.now,
): boolean {
  return processed >= PARSER_REPLAY_TRANSACTION_SIZE
    || now() - startedAt >= PARSER_REPLAY_TRANSACTION_BUDGET_MS
}

function parserReplayWindowKey(window?: SourceHistoryWindow): string {
  if (!window) return 'all'
  if (window.sessionLimit != null) return `sessions:${window.sessionLimit}`
  if (window.activeSince) return `since:${window.activeSince}`
  return 'all'
}

function parserReplayCheckpointKey(
  sourceId: string,
  installationId: string,
  targetParserVersion: string,
  window?: SourceHistoryWindow,
): string {
  return `${sourceId}:${installationId}:${targetParserVersion}:${parserReplayWindowKey(window)}`
}

function replayCheckpoint(
  sourceId: string,
  installationId: string,
  targetParserVersion: string,
  window: SourceHistoryWindow | undefined,
  state: ParserReplayCheckpoint['state'],
  cursor?: SourceRecordReplayCursor,
): ParserReplayCheckpoint {
  const updatedAt = new Date().toISOString()
  return {
    sourceId,
    installationId,
    targetParserVersion,
    window: parserReplayWindowKey(window),
    state,
    dirty: false,
    ...(cursor ? { cursor } : {}),
    updatedAt,
    ...(state === 'completed' ? { completedAt: updatedAt } : {}),
  }
}

export interface SourceHistorySyncInput {
  source: SourceDefinition
  host: Host
  detected: DetectedSource
  abortSignal: AbortSignal
  historyWindow?: SourceHistoryWindow
  /** Explicit source metadata pass; never ingests or writes transcript events. */
  mode?: 'records' | 'native-catalog'
  /** Release runtime capture only after Source-owned native file claims settle. */
  onNativeCatalogReady?: () => void
  /** 历史导入在前台请求活跃时可在记录边界暂停。 */
  cooperate?: () => Promise<void>
  queuedStatus?: SourceRuntimeStatus
  onProgress?: () => void
}

export interface SourceParserReplayInput {
  source: SourceDefinition
  host: Host
  detected: DetectedSource
  abortSignal: AbortSignal
  historyWindow?: SourceHistoryWindow
  /** Maintenance replay may pause here while foreground HTTP work is active. */
  cooperate?: () => Promise<void>
}

export interface SourceHistorySyncResult {
  sourceId: string
  installationId: string
  records: number
  /** Catalog-only files indexed; no equivalent legacy event rows. */
  nativeSessionsIndexed?: number
  /** Session identities that could not be verified; do not invent history data. */
  nativeSessionsFailed?: number
  /** A bounded native scan cannot claim full coverage when truncated. */
  nativeCatalogScanExhausted?: boolean
  nativeCoverage?: 'certified' | 'partial'
  observationsCreated: number
  observationsMerged: number
  observationsUnchanged: number
}

export interface SourceParserReplayResult {
  sourceId: string
  installationId: string
  records: number
  observationsCreated: number
  observationsMerged: number
  observationsUnchanged: number
}

export interface SourceRuntimeCaptureInput {
  source: SourceDefinition
  host: Host
  detected: DetectedSource
  abortSignal: AbortSignal
}

export interface SourceRuntimeCaptureHandle extends Disposable {
  sourceId: string
  installationId: string
  dispose(): Promise<void>
}

export interface SourceAssetDiscoveryInput {
  source: SourceDefinition
  host: Host
  detected: DetectedSource
  abortSignal: AbortSignal
}

export interface SourceAssetDiscoveryResult {
  sourceId: string
  installationId: string
  assetsDiscovered: number
  statesRecorded: number
  assetsRemoved: number
  statesCleared: number
}

interface ProcessResult {
  observationsCreated: number
  observationsMerged: number
  observationsUnchanged: number
  evidenceCandidates: EvidenceCandidate[]
}

class ScopedCheckpointService implements SourceCheckpointService {
  constructor(
    private readonly storage: StorageService,
    private readonly scope: string,
  ) {}

  get<T>(key: string): Promise<T | null> {
    return this.storage.checkpoints.get<T>(this.scope, key)
  }

  set<T>(key: string, value: T): Promise<void> {
    return this.storage.checkpoints.set<T>(this.scope, key, value)
  }

  clear(key: string): Promise<void> {
    return this.storage.checkpoints.clear(this.scope, key)
  }
}

function earlier(left: string | undefined, right: string): string {
  if (!left) return right
  return Date.parse(right) < Date.parse(left) ? right : left
}

function later(left: string | undefined, right: string): string {
  if (!left) return right
  return Date.parse(right) > Date.parse(left) ? right : left
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 1000)
  return String(error).slice(0, 1000)
}

async function putRuntimeStatus(storage: StorageService, status: SourceRuntimeStatus): Promise<void> {
  const writer = storage.sourceRuntimeStatus
  if (!writer) return
  await writer.put(status)
}

async function persistRelationshipCandidates(
  storage: StorageService,
  candidates: readonly SessionRelationshipCandidate[] | undefined,
): Promise<void> {
  if (!candidates?.length) return
  const writer = storage.sessionRelationshipCandidates
  if (!writer) return
  for (const candidate of candidates) {
    await writer.put(candidate)
    await writer.tryPromote(candidate)
  }
}

async function markRunning(
  storage: StorageService,
  sourceId: string,
  installationId: string,
  stage: SourceRuntimeStatus['stage'],
  runtimeProfileId?: string,
): Promise<SourceRuntimeStatus> {
  const status: SourceRuntimeStatus = {
    sourceId,
    installationId,
    ...(runtimeProfileId ? { runtimeProfileId } : {}),
    stage,
    state: 'running',
    lastStartedAt: new Date().toISOString(),
    errorCount: 0,
  }
  await putRuntimeStatus(storage, status)
  return status
}

async function markHealthy(storage: StorageService, status: SourceRuntimeStatus): Promise<void> {
  await putRuntimeStatus(storage, {
    ...status,
    state: 'healthy',
    lastSuccessAt: new Date().toISOString(),
  })
}

async function markFailed(
  storage: StorageService,
  status: SourceRuntimeStatus,
  error: unknown,
): Promise<void> {
  await putRuntimeStatus(storage, {
    ...status,
    state: 'failed',
    lastErrorAt: new Date().toISOString(),
    errorCount: status.errorCount + 1,
    lastErrorSummary: errorSummary(error),
  })
}

async function resolveInstallation(
  identity: IdentityService,
  host: Host,
  detected: DetectedSource,
): Promise<AgentInstallation> {
  return identity.resolveInstallation({
    hostId: host.id,
    productId: detected.productId,
    ...(detected.executable ? { executable: detected.executable } : {}),
    ...(detected.version ? { version: detected.version } : {}),
    ...(detected.configRoot ? { configRoot: detected.configRoot } : {}),
    ...(detected.dataRoot ? { dataRoot: detected.dataRoot } : {}),
  })
}

async function resolveRuntimeProfile(
  storage: StorageService,
  installation: AgentInstallation,
  detected: DetectedSource,
): Promise<RuntimeProfile | undefined> {
  if (!detected.runtimeProfile) return undefined
  const resolver = storage.runtimeProfiles
  if (!resolver) return undefined
  const profile = detected.runtimeProfile
  return resolver.resolve({
    installationId: installation.id,
    nativeProfileId: profile.nativeProfileId,
    ...(profile.name ? { name: profile.name } : {}),
    ...(profile.configRoot ?? detected.configRoot ? { configRoot: profile.configRoot ?? detected.configRoot } : {}),
    ...(profile.dataRoot ?? detected.dataRoot ? { dataRoot: profile.dataRoot ?? detected.dataRoot } : {}),
  })
}

function checkpointScope(sourceId: string, installationId: string, runtimeProfile?: RuntimeProfile): string {
  return `${sourceId}:${installationId}${runtimeProfile ? `:${runtimeProfile.id}` : ''}`
}

async function processSourceRecord(
  storage: StorageService,
  observations: ObservationService,
  coverage: CoverageService,
  capturePolicy: CapturePolicyService,
  source: SourceDefinition,
  host: Host,
  installation: AgentInstallation,
  runtimeProfile: RuntimeProfile | undefined,
  record: SourceRecord,
): Promise<ProcessResult> {
  let normalized
  try {
    normalized = await source.normalize(record, {
      host,
      installation,
      ...(runtimeProfile ? { runtimeProfile } : {}),
    })
  } catch (error) {
    await storage.repositories.sourceRecords.put(capturePolicy.sanitizeSourceRecord(record))
    throw error
  }

  const persistedRecord = capturePolicy.sanitizeSourceRecord(record, normalized)
  const persistedOutput = capturePolicy.sanitizeNormalizedOutput(normalized)

  const result: ProcessResult = {
    observationsCreated: 0,
    observationsMerged: 0,
    observationsUnchanged: 0,
    evidenceCandidates: persistedOutput.evidenceCandidates,
  }

  await storage.transaction(async () => {
    await storage.repositories.sourceRecords.put(persistedRecord)

    const evidenceRepository = storage.repositories.evidence
    if (!persistedOutput.observations.length && evidenceRepository) {
      for (const candidate of persistedOutput.evidenceCandidates) {
        await evidenceRepository.put(materializeEvidence(candidate))
      }
    }

    for (const observation of persistedOutput.observations) {
      if (runtimeProfile && !observation.identityHints.runtimeProfileNativeId) {
        observation.identityHints.runtimeProfileNativeId = runtimeProfile.nativeProfileId
      }
      const committed = await observations.commit({
        sourceId: source.manifest.sourceId,
        host,
        installation,
        candidate: observation,
        evidenceCandidates: persistedOutput.evidenceCandidates,
      })

      if (committed.status === 'created') result.observationsCreated += 1
      else if (committed.status === 'merged') result.observationsMerged += 1
      else result.observationsUnchanged += 1
    }
  })

  const explicitRelationships = persistedOutput.sessionRelationshipHints ?? []
  const observationProfileIds = new Set(
    persistedOutput.observations
      .map(observation => observation.identityHints.runtimeProfileNativeId)
      .filter((value): value is string => Boolean(value)),
  )
  const relationshipRuntimeProfileId = runtimeProfile
    && (
      observationProfileIds.size === 0
      || (observationProfileIds.size === 1 && observationProfileIds.has(runtimeProfile.nativeProfileId))
    )
    ? runtimeProfile.id
    : undefined
  const derivedRelationships = deriveParentRelationshipCandidates(
    source.manifest.sourceId,
    installation.id,
    persistedOutput.observations,
  ).map(candidate => relationshipRuntimeProfileId
    ? { ...candidate, runtimeProfileId: relationshipRuntimeProfileId }
    : candidate)
  const relationshipCandidates = explicitRelationships.length ? explicitRelationships : derivedRelationships
  await persistRelationshipCandidates(storage, relationshipCandidates)

  for (const declaration of persistedOutput.coverage ?? []) {
    await coverage.declare(declaration)
  }

  return result
}

function noPersistedObservations(): ProcessResult {
  return {
    observationsCreated: 0,
    observationsMerged: 0,
    observationsUnchanged: 0,
    evidenceCandidates: [],
  }
}

/**
 * Select a storage owner once per source-native session, for BOTH history and
 * runtime. A durable native-only claim must never fall back into the legacy
 * SourceRecord/Observation/Evidence pipeline, even if the opt-in is removed.
 *
 * Certified append-oriented Sources select Native-only by default for
 * unclaimed sessions. Existing Legacy claims remain immutable, and uncertain
 * records use the legacy pipeline. The Source reader must authorize the file.
 */
/** Only append-oriented, fingerprint-stable original sources may replace
 * durable SQL events. Mutable SQLite rowIds cannot guarantee recovery after
 * compaction or in-place updates even if they happen to verify today.
 */
function isDurablyNativeRecoverable(
  source: SourceDefinition,
  record: SourceRecord,
): boolean {
  const capability = source.rawRecovery?.describe(record)
  if (source.nativeSessionCoverageComplete !== true || !capability?.canReread
    || !capability.canReparse || !capability.replayable
    || capability.authority !== 'native-store'
    || capability.verification !== 'fingerprint'
    || capability.persistencePreference !== 'reference') return false
  // Immutable JSONL records are always verified by original offset/hash.
  if (record.locator.kind === 'file') {
    return capability.locatorStability === 'stable'
      && capability.mutability === 'append-oriented'
  }
  // Mutable SQLite rowids are NOT durable event identities. Only a Source
  // explicitly attesting that its entire CURRENT per-session state can be
  // re-read from the same native DB snapshot may avoid second persistence.
  // This deliberately does not promise overwritten/deleted historical rows.
  return record.locator.kind === 'database'
    && capability.recoveryScope === 'session-current-state'
    && capability.locatorStability === 'best-effort'
    && capability.mutability === 'mutable'
}

async function shouldReadNativeOnly(
  storage: StorageService,
  tracker: NativeSessionCatalogTracker,
  source: SourceDefinition,
  host: Host,
  installation: AgentInstallation,
  runtimeProfile: RuntimeProfile | undefined,
  record: SourceRecord,
  signal: AbortSignal,
): Promise<boolean> {
  const catalog = storage.nativeSessionCatalog
  const nativeSessionId = record.sourceSessionNativeId
  if (!catalog || !nativeSessionId) return false
  const key = {
    sourceId: record.sourceId,
    installationId: record.installationId,
    nativeSessionId,
  }
  // Two independent runners may race for the same session. Every path must
  // claim an immutable owner BEFORE persisting legacy events or skipping them.
  const verifyClaimedNativeRecord = async (): Promise<boolean> => {
    // A competing history/runtime writer may have claimed native-only between
    // our ownership read and claimLegacyWrite(). Its claim is NOT permission to
    // skip this particular record without verifying the original bytes.
    const preparedHook=record.locator.kind==='runtime-hook'
    // Runtime-only facts are not part of the native JSONL/SQLite catalog
    // path. They may skip SQL only after the Source proves the separate
    // single-copy, installation/session-scoped Hook archive is already sealed.
    // An unclaimed Hook can NEVER establish Native-only ownership by itself.
    const recoverable=preparedHook
      ? Boolean(source.nativeSessionCoverageComplete===true
        && (source.readArchivedNativeHooksPage || source.readArchivedNativeHooks))
      : isDurablyNativeRecoverable(source,record)
    if (!recoverable || !source.rawRecovery?.verify
      || record.sourceId!==source.manifest.sourceId
      || record.installationId!==installation.id
      || !record.locator.path || !record.fingerprint) {
      throw new Error('native-only-source-recovery-coverage-drift')
    }
    signal.throwIfAborted()
    const registered = await catalog.get({ ...key, locationKind: 'native' })
    if (!registered || (!preparedHook && registered.filePath!==record.locator.path)) {
      throw new Error('native-only-source-record-location-drift')
    }
    const verification = await source.rawRecovery.verify(record, {
      host, installation,
      ...(runtimeProfile ? { runtimeProfile } : {}),
      abortSignal: signal,
      checkpoint: {
        async get() { return null },
        async set() { throw new Error('Native-only verification cannot update checkpoints') },
        async clear() { throw new Error('Native-only verification cannot remove checkpoints') },
      } satisfies SourceCheckpointService,
    })
    if (verification.state !== 'verified') {
      throw new Error('native-only-source-record-recovery-drift')
    }
    return true
  }
  const established = await tracker.getWriteMode(key)
  if (established === 'native-only') return verifyClaimedNativeRecord()
  if (established === 'legacy') return false
  const claimLegacy = async () => {
    const mode = await catalog.claimLegacyWrite(key)
    tracker.rememberWriteMode(key, mode)
    // claimLegacyWrite is an atomic first-writer-wins operation. A competing
    // native-only owner can win while this writer is deciding on Legacy.
    // Revalidate this record before skipping it; never treat the competing
    // *session* claim as proof of *this event's* durable recoverability.
    return mode === 'native-only' ? verifyClaimedNativeRecord() : false
  }
  if (!source.readNativeSessionPage || !source.rawRecovery?.verify
    || !isDurablyNativeRecoverable(source, record)
    || record.sourceId !== source.manifest.sourceId
    || record.installationId !== installation.id
    || !record.locator.path || !record.fingerprint) return claimLegacy()

  signal.throwIfAborted()
  const context = {
    host, installation,
    ...(runtimeProfile ? { runtimeProfile } : {}),
    abortSignal: signal,
    checkpoint: {
      async get() { return null },
      async set() { throw new Error('Native-only writer cannot update source checkpoints') },
      async clear() { throw new Error('Native-only writer cannot remove source checkpoints') },
    } satisfies SourceCheckpointService,
  }
  const verification = await source.rawRecovery.verify(record, context)
  if (verification.state !== 'verified') return claimLegacy()

  // The Catalog update is metadata-only. This MUST succeed before claiming
  // native ownership. A throttled row may already be durable from this Source.
  await tracker.observe(source, record)
  const native = await catalog.get({ ...key, locationKind: 'native' })
  if (!native || native.filePath !== record.locator.path) return claimLegacy()

  const probe = await source.readNativeSessionPage({
    filePath: native.filePath,
    nativeSessionId,
    limit: 1,
  }, context)
  if (probe.state !== 'available'
    || probe.nextCursor.fileIdentity !== native.fileIdentity
    || probe.records.length === 0) return claimLegacy()

  const nativeOnly = await catalog.claimNativeOnlyWrite({
    ...key, filePath: native.filePath, fileIdentity: native.fileIdentity,
  })
  if (nativeOnly) tracker.rememberWriteMode(key, 'native-only')
  // If the competing legacy writer claimed this session while Source proof
  // was in flight, honor its decision instead of mixing the two histories.
  return nativeOnly || claimLegacy()
}

async function processSourceRecordWithOwnership(
  storage: StorageService,
  observations: ObservationService,
  coverage: CoverageService,
  capturePolicy: CapturePolicyService,
  tracker: NativeSessionCatalogTracker,
  source: SourceDefinition,
  host: Host,
  installation: AgentInstallation,
  runtimeProfile: RuntimeProfile | undefined,
  record: SourceRecord,
  signal: AbortSignal,
): Promise<ProcessResult> {
  if (await shouldReadNativeOnly(storage, tracker, source, host, installation, runtimeProfile, record, signal)) {
    // Do not normalize, create Evidence, commit Canonical observations or
    // duplicate raw SourceRecords. Read-time Source normalization owns this.
    return noPersistedObservations()
  }
  // Legacy remains for existing SQL sessions and any unverified Source facts.
  return processSourceRecord(storage, observations, coverage, capturePolicy,
    source, host, installation, runtimeProfile, record)
}

export class SourceHistoryRunner {
  private readonly nativeCatalogTracker: NativeSessionCatalogTracker

  constructor(
    private readonly storage: StorageService,
    private readonly identity: IdentityService,
    private readonly observations: ObservationService,
    private readonly capabilities: CapabilityService,
    private readonly coverage: CoverageService,
    private readonly capturePolicy: CapturePolicyService,
  ) {
    this.nativeCatalogTracker = new NativeSessionCatalogTracker(storage.nativeSessionCatalog)
  }

  async replay(input: SourceParserReplayInput): Promise<SourceParserReplayResult> {
    const { source, host, detected, abortSignal } = input
    if (source.manifest.sourceId !== detected.sourceId) {
      throw new Error(`Source mismatch: definition=${source.manifest.sourceId}, detected=${detected.sourceId}`)
    }

    const installation = await resolveInstallation(this.identity, host, detected)
    const runtimeProfile = await resolveRuntimeProfile(this.storage, installation, detected)
    const result: SourceParserReplayResult = {
      sourceId: source.manifest.sourceId,
      installationId: installation.id,
      records: 0,
      observationsCreated: 0,
      observationsMerged: 0,
      observationsUnchanged: 0,
    }
    const replay = this.storage.repositories.sourceRecords.listForParserReplay
    if (!replay) return result

    const checkpointKey = parserReplayCheckpointKey(
      source.manifest.sourceId,
      installation.id,
      source.manifest.parserVersion,
      input.historyWindow,
    )
    let versionedCheckpoint = await readReplayCheckpoint(this.storage, checkpointKey)
    const existingCheckpoint = versionedCheckpoint?.value
    if (
      existingCheckpoint?.targetParserVersion === source.manifest.parserVersion
      && existingCheckpoint.state === 'completed'
      && !existingCheckpoint.dirty
    ) {
      return result
    }

    let after = existingCheckpoint?.targetParserVersion === source.manifest.parserVersion
      && !existingCheckpoint.dirty
      ? existingCheckpoint.cursor
      : undefined
    const claimed = await compareAndSetReplayCheckpoint(
      this.storage,
      checkpointKey,
      versionedCheckpoint?.revision ?? null,
      replayCheckpoint(
        source.manifest.sourceId,
        installation.id,
        source.manifest.parserVersion,
        input.historyWindow,
        'running',
        after,
      ),
    )
    if (!claimed) {
      versionedCheckpoint = await readReplayCheckpoint(this.storage, checkpointKey)
      const latest = versionedCheckpoint?.value
      if (
        latest?.targetParserVersion === source.manifest.parserVersion
        && latest.state === 'completed'
        && !latest.dirty
      ) {
        return result
      }
      return result
    }

    const yieldForInteractivity = createCooperativeScheduler()
    let invalidated = false
    while (!abortSignal.aborted && !invalidated) {
      if (input.cooperate) await input.cooperate()
      if (abortSignal.aborted) break

      const records = await replay(
        source.manifest.sourceId,
        installation.id,
        source.manifest.parserVersion,
        after,
        500,
        input.historyWindow,
      )
      if (!records.length) {
        const latestCheckpoint = await readReplayCheckpoint(this.storage, checkpointKey)
        if (latestCheckpoint?.value.dirty) break
        const completed = await compareAndSetReplayCheckpoint(
          this.storage,
          checkpointKey,
          latestCheckpoint?.revision ?? null,
          replayCheckpoint(
            source.manifest.sourceId,
            installation.id,
            source.manifest.parserVersion,
            input.historyWindow,
            'completed',
            after,
          ),
        )
        if (!completed) invalidated = true
        break
      }

      let offset = 0
      while (offset < records.length && !abortSignal.aborted && !invalidated) {
        if (input.cooperate) await input.cooperate()
        if (abortSignal.aborted) break

        let lastProcessed: SourceRecord | undefined
        await this.storage.transaction(async () => {
          const transactionStartedAt = Date.now()
          let processedInTransaction = 0
          while (offset < records.length && !abortSignal.aborted) {
            const stored = records[offset]!
            const processed = await processSourceRecord(
              this.storage,
              this.observations,
              this.coverage,
              this.capturePolicy,
              source,
              host,
              installation,
              runtimeProfile,
              { ...stored, parserVersion: source.manifest.parserVersion },
            )
            lastProcessed = stored
            offset += 1
            processedInTransaction += 1
            result.records += 1
            result.observationsCreated += processed.observationsCreated
            result.observationsMerged += processed.observationsMerged
            result.observationsUnchanged += processed.observationsUnchanged
            if (parserReplayTransactionExpired(transactionStartedAt, processedInTransaction)) break
          }
        })

        if (lastProcessed) {
          after = {
            parserVersion: lastProcessed.parserVersion,
            capturedAt: lastProcessed.capturedAt,
            id: lastProcessed.id,
          }
          const latestCheckpoint = await readReplayCheckpoint(this.storage, checkpointKey)
          if (latestCheckpoint?.value.dirty) {
            invalidated = true
            break
          }
          const advanced = await compareAndSetReplayCheckpoint(
            this.storage,
            checkpointKey,
            latestCheckpoint?.revision ?? null,
            replayCheckpoint(
              source.manifest.sourceId,
              installation.id,
              source.manifest.parserVersion,
              input.historyWindow,
              'running',
              after,
            ),
          )
          if (!advanced) {
            invalidated = true
            break
          }
        }
        await yieldForInteractivity()
      }
    }
    return result
  }

  async queue(input: SourceHistorySyncInput): Promise<SourceRuntimeStatus> {
    const installation = await resolveInstallation(this.identity, input.host, input.detected)
    const profile = await resolveRuntimeProfile(this.storage, installation, input.detected)
    const status = queuedHistoryStatus(input.source.manifest.sourceId, installation.id, profile?.id)
    await putRuntimeStatus(this.storage, status)
    return status
  }

  async cancelQueued(status: SourceRuntimeStatus): Promise<void> {
    await new SourceHistoryProgressTracker(this.storage, status).settle('cancelled')
  }

  async sync(input: SourceHistorySyncInput): Promise<SourceHistorySyncResult> {
    const { source, host, detected, abortSignal } = input
    if (source.manifest.sourceId !== detected.sourceId) {
      throw new Error(`Source mismatch: definition=${source.manifest.sourceId}, detected=${detected.sourceId}`)
    }

    const installation = await resolveInstallation(this.identity, host, detected)
    const runtimeProfile = await resolveRuntimeProfile(this.storage, installation, detected)
    const runtimeStatus = input.queuedStatus ?? queuedHistoryStatus(source.manifest.sourceId, installation.id, runtimeProfile?.id)
    const progress = new SourceHistoryProgressTracker(this.storage, runtimeStatus, input.onProgress)

    try {
      await progress.begin()
      const declaredCapabilities = await source.declareCapabilities(detected)
      this.capabilities.registerSourceCapabilities(source.manifest.sourceId, declaredCapabilities)

      const result: SourceHistorySyncResult = {
        sourceId: source.manifest.sourceId,
        installationId: installation.id,
        records: 0,
        observationsCreated: 0,
        observationsMerged: 0,
        observationsUnchanged: 0,
      }
      const yieldForInteractivity = createCooperativeScheduler()

      if (input.mode === 'native-catalog') {
        const catalog = this.storage.nativeSessionCatalog
        if (!catalog) throw new Error('Source native catalog discovery is unsupported')
        // This mode is now strictly a Source-verified metadata scan. It must
        // never invoke ingestHistory, SourceRecord storage, or Legacy Claims.
        const maxSessions = input.historyWindow?.sessionLimit ?? 32
        const activeInstallation = runtimeProfile
          ? { ...installation,
              ...(runtimeProfile.configRoot !== undefined ? { configRoot: runtimeProfile.configRoot } : {}),
              ...(runtimeProfile.dataRoot !== undefined ? { dataRoot: runtimeProfile.dataRoot } : {}) }
          : installation
        const scanned = await new NativeOnlySourceIndexer(catalog).scan({
          source,host,installation:activeInstallation,
          ...(runtimeProfile ? { runtimeProfile } : {}),
          signal:abortSignal,maxSessions,
          ...(input.historyWindow ? { historyWindow:input.historyWindow } : {}),
        })
        result.nativeSessionsIndexed = scanned.indexed
        result.nativeSessionsFailed = scanned.scanned - scanned.indexed
        result.nativeCatalogScanExhausted = scanned.exhausted
        result.nativeCoverage = scanned.nativeCoverage
        // Partial or truncated scans remain visible to the caller; they
        // must never trigger a second copy in Canonical SQL.
        input.onNativeCatalogReady?.()
        await progress.phase('checkpoint')
        await progress.settle(abortSignal.aborted ? 'cancelled' : 'completed')
        return result
      }


      if (!source.ingestHistory) {
        await progress.phase('checkpoint')
        await progress.settle(abortSignal.aborted ? 'cancelled' : 'completed')
        return result
      }

      const checkpoint = new ScopedCheckpointService(
        this.storage,
        checkpointScope(source.manifest.sourceId, installation.id, runtimeProfile),
      )
      const verifiedNativePaths = new Set<string>()
      const verifiedNativeSessionIds = new Set<string>()
      // Certified Sources claim only after original Source verification.
      // Existing SQL sessions refuse the claim and preserve Legacy ownership.
      if (source.nativeSessionCoverageComplete === true
        && source.discoverNativeSessions && source.readNativeSessionPage
        && source.rawRecovery?.verify && this.storage.nativeSessionCatalog) {
        const catalog = this.storage.nativeSessionCatalog
        const context = {
          host, installation,
          ...(runtimeProfile ? { runtimeProfile } : {}),
          abortSignal, checkpoint,
        }
        for await (const entry of source.discoverNativeSessions({
          ...context,
          ...(input.historyWindow ? { historyWindow: input.historyWindow } : {}),
        })) {
          if (abortSignal.aborted) break
          if (entry.sourceId !== source.manifest.sourceId
            || entry.installationId !== installation.id
            || entry.locationKind !== 'native') {
            throw new Error('Native Catalog fast scan returned a foreign Source identity')
          }
          // No blind claims from filename/mtime: the source-owned reader must
          // prove matching native session + physical identity and first-row
          // fingerprint before skipping the original history parser.
          let first: Awaited<ReturnType<NonNullable<SourceDefinition['readNativeSessionPage']>>>
          try {
            first = await source.readNativeSessionPage({
              filePath: entry.filePath, nativeSessionId: entry.nativeSessionId, limit: 1,
            }, context)
          } catch (error) {
            if (abortSignal.aborted) throw error
            // A transient file/path failure must leave ingestion in legacy
            // mode, not turn a metadata row into an unverified native claim.
            continue
          }
          if (first.state !== 'available' || !first.records.length
            || first.nextCursor.fileIdentity !== entry.fileIdentity) continue
          const record = first.records[0]!
          if (record.sourceId !== entry.sourceId
            || record.installationId !== entry.installationId
            || record.sourceSessionNativeId !== entry.nativeSessionId
            || record.locator.path !== entry.filePath
            || !record.fingerprint
            || !isDurablyNativeRecoverable(source, record)) continue
          let verified = false
          try {
            verified = (await source.rawRecovery.verify(record, context)).state === 'verified'
          } catch (error) {
            if (abortSignal.aborted) throw error
            continue
          }
          if (!verified) continue
          await catalog.upsert(entry)
          const key = { sourceId: entry.sourceId,
            installationId: entry.installationId,
            nativeSessionId: entry.nativeSessionId }
          if (await catalog.claimNativeOnlyWrite({
            ...key, filePath: entry.filePath, fileIdentity: entry.fileIdentity,
          })) {
            // Shared native SQLite databases contain several independently
            // claimed sessions. Never exclude all rows by the common DB path.
            if (record.locator.kind === 'file') verifiedNativePaths.add(entry.filePath)
            verifiedNativeSessionIds.add(entry.nativeSessionId)
            this.nativeCatalogTracker.rememberWriteMode(key, 'native-only')
          }
          if (input.cooperate) await input.cooperate()
          await yieldForInteractivity()
        }
      }
      // Metadata ownership arbitration precedes legacy-only ingestion.
      input.onNativeCatalogReady?.()
      let coverageFrom: string | undefined
      let coverageTo: string | undefined
      let coverageFromEvidence: EvidenceCandidate[] = []
      let coverageToEvidence: EvidenceCandidate[] = []

      for await (const record of source.ingestHistory({
        host,
        installation,
        ...(runtimeProfile ? { runtimeProfile } : {}),
        abortSignal,
        checkpoint,
        ...(input.historyWindow ? { historyWindow: input.historyWindow } : {}),
        ...(verifiedNativePaths.size
          ? { skipNativeSessionFile: (filePath: string) => verifiedNativePaths.has(filePath) } : {}),
        ...(verifiedNativeSessionIds.size
          ? { skipNativeSessionId: (id: string) => verifiedNativeSessionIds.has(id) } : {}),
        reportProgress: update => progress.report(update),
      })) {
        if (input.cooperate) await input.cooperate()
        if (abortSignal.aborted) break
        result.records += 1
        const processed = await processSourceRecordWithOwnership(
          this.storage,
          this.observations,
          this.coverage,
          this.capturePolicy,
          this.nativeCatalogTracker,
          source,
          host,
          installation,
          runtimeProfile,
          record,
          abortSignal,
        )
        result.observationsCreated += processed.observationsCreated
        result.observationsMerged += processed.observationsMerged
        result.observationsUnchanged += processed.observationsUnchanged
        // Update only once per active native file window; indexing is best effort
        // and must not fail the primary ingestion or delay startup with rescans.
        try {
          await this.nativeCatalogTracker.observe(source, record)
        } catch (error) {
          console.warn('[AgentLens] native session catalog update failed', {
            sourceId: source.manifest.sourceId,
            code: (error as NodeJS.ErrnoException).code ?? 'unknown',
          })
        }
        await progress.record(result)

        const time = record.occurredAt ?? record.capturedAt
        const nextFrom = earlier(coverageFrom, time)
        if (nextFrom !== coverageFrom) {
          coverageFrom = nextFrom
          coverageFromEvidence = processed.evidenceCandidates
        }
        const nextTo = later(coverageTo, time)
        if (nextTo !== coverageTo) {
          coverageTo = nextTo
          coverageToEvidence = processed.evidenceCandidates
        }
        await yieldForInteractivity()
      }

      if (!abortSignal.aborted) {
        await progress.phase('processing')
        await progress.phase('checkpoint')
        for (const capability of declaredCapabilities) {
          if (capability.status === 'unavailable' || capability.status === 'not-applicable') {
            await this.coverage.declare({
              subjectType: runtimeProfile ? 'RuntimeProfile' : 'AgentInstallation',
              subjectId: runtimeProfile?.id ?? installation.id,
              capability: capability.name,
              status: 'unavailable',
              reason: capability.reason ?? `Source reports capability as ${capability.status}`,
            })
            continue
          }
          if (!capability.captureModes.includes('history')) continue
          if (!coverageFrom || !coverageTo) continue
          const boundaryEvidence = coverageFrom === coverageTo
            ? coverageFromEvidence
            : [...coverageFromEvidence, ...coverageToEvidence]
          await this.coverage.declare({
            subjectType: runtimeProfile ? 'RuntimeProfile' : 'AgentInstallation',
            subjectId: runtimeProfile?.id ?? installation.id,
            capability: capability.name,
            from: coverageFrom,
            to: coverageTo,
            status: capability.status === 'available' ? 'complete' : 'partial',
            ...(capability.reason ? { reason: capability.reason } : {}),
            ...(boundaryEvidence.length ? { evidenceCandidates: boundaryEvidence } : {}),
          })
        }
      }

      await progress.settle(abortSignal.aborted ? 'cancelled' : 'completed')
      return result
    } catch (error) {
      await progress.settle(abortSignal.aborted ? 'cancelled' : 'failed', errorSummary(error))
      throw error
    } finally {
      progress.dispose()
    }
  }
}

export class SourceRuntimeRunner {
  private readonly nativeCatalogTracker: NativeSessionCatalogTracker

  constructor(
    private readonly storage: StorageService,
    private readonly identity: IdentityService,
    private readonly observations: ObservationService,
    private readonly capabilities: CapabilityService,
    private readonly coverage: CoverageService,
    private readonly capturePolicy: CapturePolicyService,
  ) {
    this.nativeCatalogTracker = new NativeSessionCatalogTracker(storage.nativeSessionCatalog)
  }

  async start(input: SourceRuntimeCaptureInput): Promise<SourceRuntimeCaptureHandle> {
    const { source, host, detected, abortSignal } = input
    if (source.manifest.sourceId !== detected.sourceId) {
      throw new Error(`Source mismatch: definition=${source.manifest.sourceId}, detected=${detected.sourceId}`)
    }

    const installation = await resolveInstallation(this.identity, host, detected)
    const runtimeProfile = await resolveRuntimeProfile(this.storage, installation, detected)
    const runtimeStatus = await markRunning(
      this.storage,
      source.manifest.sourceId,
      installation.id,
      'runtime',
      runtimeProfile?.id,
    )
    try {
      const declaredCapabilities = await source.declareCapabilities(detected)
      const capabilityRegistration = this.capabilities.registerSourceCapabilities(source.manifest.sourceId, declaredCapabilities)

      if (!source.startCapture) {
        await markHealthy(this.storage, runtimeStatus)
        return {
          sourceId: source.manifest.sourceId,
          installationId: installation.id,
          async dispose(): Promise<void> {
            await capabilityRegistration.dispose()
          },
        }
      }

      const checkpoint = new ScopedCheckpointService(
        this.storage,
        checkpointScope(source.manifest.sourceId, installation.id, runtimeProfile),
      )
      let closed = false
      let tail: Promise<void> = Promise.resolve()

      const capture = await source.startCapture(
        {
          host,
          installation,
          ...(runtimeProfile ? { runtimeProfile } : {}),
          abortSignal,
          checkpoint,
        },
        {
          emit: (record) => {
            if (closed) throw new Error(`Source runtime is closed: ${source.manifest.sourceId}`)
            const task = tail.then(async () => {
              try {
                await processSourceRecordWithOwnership(
                  this.storage,
                  this.observations,
                  this.coverage,
                  this.capturePolicy,
                  this.nativeCatalogTracker,
                  source,
                  host,
                  installation,
                  runtimeProfile,
                  record,
                  abortSignal,
                )
                try {
                  await this.nativeCatalogTracker.observe(source, record)
                } catch (error) {
                  console.warn('[AgentLens] native session catalog update failed', {
                    sourceId: source.manifest.sourceId,
                    code: (error as NodeJS.ErrnoException).code ?? 'unknown',
                  })
                }
                await markHealthy(this.storage, runtimeStatus)
              } catch (error) {
                await markFailed(this.storage, runtimeStatus, error)
                throw error
              }
            })
            tail = task.then(() => undefined, () => undefined)
            return task
          },
        },
      )

      await markHealthy(this.storage, runtimeStatus)
      return {
        sourceId: source.manifest.sourceId,
        installationId: installation.id,
        async dispose(): Promise<void> {
          if (closed) return
          closed = true
          try {
            await capture.dispose()
            await tail
          } finally {
            await capabilityRegistration.dispose()
          }
        },
      }
    } catch (error) {
      await markFailed(this.storage, runtimeStatus, error)
      throw error
    }
  }
}

export class SourceAssetRunner {
  constructor(
    private readonly storage: StorageService,
    private readonly identity: IdentityService,
    private readonly capabilities: CapabilityService,
    private readonly assets: AssetService,
    private readonly evidence: EvidenceService,
    private readonly capturePolicy: CapturePolicyService,
  ) {}

  async scan(input: SourceAssetDiscoveryInput): Promise<SourceAssetDiscoveryResult> {
    const { source, host, detected, abortSignal } = input
    if (source.manifest.sourceId !== detected.sourceId) {
      throw new Error(`Source mismatch: definition=${source.manifest.sourceId}, detected=${detected.sourceId}`)
    }

    const installation = await resolveInstallation(this.identity, host, detected)
    const runtimeProfile = await resolveRuntimeProfile(this.storage, installation, detected)
    const runtimeStatus = await markRunning(
      this.storage,
      source.manifest.sourceId,
      installation.id,
      'assets',
      runtimeProfile?.id,
    )
    try {
      const declaredCapabilities = await source.declareCapabilities(detected)
      this.capabilities.registerSourceCapabilities(source.manifest.sourceId, declaredCapabilities)

      const result: SourceAssetDiscoveryResult = {
        sourceId: source.manifest.sourceId,
        installationId: installation.id,
        assetsDiscovered: 0,
        statesRecorded: 0,
        assetsRemoved: 0,
        statesCleared: 0,
      }
      if (!source.discoverAssets || !this.capturePolicy.isEnabled('config')) {
        await markHealthy(this.storage, runtimeStatus)
        return result
      }

      const checkpoint = new ScopedCheckpointService(
        this.storage,
        checkpointScope(source.manifest.sourceId, installation.id, runtimeProfile),
      )
      const previousSnapshot = await checkpoint.get<AssetDiscoverySnapshot>(ASSET_DISCOVERY_SNAPSHOT_KEY)
      const currentBindings = new Map<string, Set<AssetState>>()
      const reportedBindingStates = new Map<string, Set<AssetState>>()
      const yieldForInteractivity = createCooperativeScheduler()

      for await (const discovered of source.discoverAssets({
        host,
        installation,
        ...(runtimeProfile ? { runtimeProfile } : {}),
        abortSignal,
        checkpoint,
      })) {
        if (abortSignal.aborted) break
        const safeDiscovered = this.capturePolicy.sanitizeDiscoveredAsset(discovered)
        if (!safeDiscovered) continue

        const definition = await this.assets.resolveDefinition(safeDiscovered.definition)
        const binding = await this.assets.resolveBinding({
          assetId: definition.id,
          installationId: installation.id,
          ...(safeDiscovered.binding?.runtimeProfileId ?? runtimeProfile?.id
            ? { runtimeProfileId: safeDiscovered.binding?.runtimeProfileId ?? runtimeProfile!.id }
            : {}),
          ...(safeDiscovered.binding?.scope ? { scope: safeDiscovered.binding.scope } : {}),
          ...(safeDiscovered.binding?.scopeRoot ? { scopeRoot: safeDiscovered.binding.scopeRoot } : {}),
          ...(safeDiscovered.binding?.path ? { path: safeDiscovered.binding.path } : {}),
          ...(safeDiscovered.binding?.source ? { source: safeDiscovered.binding.source } : {}),
          ...(safeDiscovered.binding?.version ? { version: safeDiscovered.binding.version } : {}),
        })
        result.assetsDiscovered += 1
        const bindingStates = currentBindings.get(binding.id) ?? new Set<AssetState>()
        currentBindings.set(binding.id, bindingStates)
        const reportedStates = reportedBindingStates.get(binding.id) ?? new Set<AssetState>()
        reportedBindingStates.set(binding.id, reportedStates)
        for (const state of safeDiscovered.states ?? []) {
          const evidenceRefs: string[] = []
          for (const candidate of state.evidenceCandidates ?? []) {
            evidenceRefs.push((await this.evidence.create(candidate)).id)
          }
          await this.assets.recordState({
            assetBindingId: binding.id,
            state: state.state,
            value: state.value,
            observedAt: state.observedAt,
            evidenceRefs,
          })
          reportedStates.add(state.state)
          if (state.value === true && ASSET_PRESENCE_STATES.has(state.state)) bindingStates.add(state.state)
          result.statesRecorded += 1
        }

        await yieldForInteractivity()
      }

      if (!abortSignal.aborted) {
        const completedAt = new Date().toISOString()
        const currentSnapshot: AssetDiscoverySnapshot = {
          bindings: Object.fromEntries(
            [...currentBindings].map(([bindingId, states]) => [bindingId, [...states].sort()]),
          ),
          completedAt,
        }

        // Omission means unknown. This also neutralizes optimistic states written by older
        // SourceAssetRunner versions when the binding still exists but the source no longer
        // reports enough evidence for that state.
        for (const [bindingId, reportedStates] of reportedBindingStates) {
          for (const state of previousSnapshot?.bindings[bindingId] ?? []) {
            if (!ASSET_PRESENCE_STATES.has(state) || reportedStates.has(state)) continue
            await this.assets.recordState({
              assetBindingId: bindingId,
              state,
              value: 'unknown',
              observedAt: completedAt,
              evidenceRefs: [],
            })
            result.statesCleared += 1
          }
        }

        for (const [bindingId, states] of Object.entries(previousSnapshot?.bindings ?? {})) {
          if (currentBindings.has(bindingId)) continue
          result.assetsRemoved += 1
          for (const state of states) {
            if (!ASSET_PRESENCE_STATES.has(state)) continue
            await this.assets.recordState({
              assetBindingId: bindingId,
              state,
              value: ASSET_INVENTORY_STATES.has(state) ? false : 'unknown',
              observedAt: completedAt,
              evidenceRefs: [],
            })
            result.statesCleared += 1
          }
        }
        await checkpoint.set(ASSET_DISCOVERY_SNAPSHOT_KEY, currentSnapshot)
      }

      await markHealthy(this.storage, runtimeStatus)
      return result
    } catch (error) {
      await markFailed(this.storage, runtimeStatus, error)
      throw error
    }
  }
}

export const sourceRunnerInternals = {
  processSourceRecordWithOwnership,
  createCooperativeScheduler,
  parserReplayCheckpointKey,
  parserReplayWindowKey,
  parserReplayTransactionExpired,
  DEFAULT_COOPERATIVE_BUDGET_MS,
  PARSER_REPLAY_TRANSACTION_SIZE,
  PARSER_REPLAY_TRANSACTION_BUDGET_MS,
  PARSER_REPLAY_CHECKPOINT_SCOPE,
  ASSET_DISCOVERY_SNAPSHOT_KEY,
  ASSET_INVENTORY_STATES,
  ASSET_PRESENCE_STATES,
}
