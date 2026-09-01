import type {
  AgentInstallation,
  AssetService,
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
  SourceRuntimeStatus,
  StorageService,
} from '@agent-lens/core'
import { deriveParentRelationshipCandidates } from './relationship-hints'

const DEFAULT_COOPERATIVE_BUDGET_MS = 8

interface CooperativeSchedulerOptions {
  budgetMs?: number
  now?: () => number
  yieldControl?: () => Promise<void>
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

export interface SourceHistorySyncInput {
  source: SourceDefinition
  host: Host
  detected: DetectedSource
  abortSignal: AbortSignal
  historyWindow?: SourceHistoryWindow
}

export interface SourceHistorySyncResult {
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
}

interface ProcessResult {
  observationsCreated: number
  observationsMerged: number
  observationsUnchanged: number
  evidenceCandidates: EvidenceCandidate[]
}

interface RuntimeStatusWriter {
  put(status: SourceRuntimeStatus): Promise<void>
}

interface RelationshipCandidateWriter {
  put(candidate: SessionRelationshipCandidate): Promise<void>
  tryPromote(candidate: SessionRelationshipCandidate): Promise<unknown>
}

interface RuntimeProfileResolver {
  resolve(hint: {
    installationId: string
    nativeProfileId: string
    name?: string
    configRoot?: string
    dataRoot?: string
  }): Promise<RuntimeProfile>
}

type StorageWithRuntimeExtensions = StorageService & {
  sourceRuntimeStatus?: RuntimeStatusWriter
  sessionRelationshipCandidates?: RelationshipCandidateWriter
  runtimeProfiles?: RuntimeProfileResolver
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
  const writer = (storage as StorageWithRuntimeExtensions).sourceRuntimeStatus
  if (!writer) return
  await writer.put(status)
}

async function persistRelationshipCandidates(
  storage: StorageService,
  candidates: readonly SessionRelationshipCandidate[] | undefined,
): Promise<void> {
  if (!candidates?.length) return
  const writer = (storage as StorageWithRuntimeExtensions).sessionRelationshipCandidates
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
  const profileScoped = Boolean(detected.runtimeProfile)
  return identity.resolveInstallation({
    hostId: host.id,
    productId: detected.productId,
    ...(detected.executable ? { executable: detected.executable } : {}),
    ...(detected.version ? { version: detected.version } : {}),
    ...(!profileScoped && detected.configRoot ? { configRoot: detected.configRoot } : {}),
    ...(!profileScoped && detected.dataRoot ? { dataRoot: detected.dataRoot } : {}),
  })
}

async function resolveRuntimeProfile(
  storage: StorageService,
  installation: AgentInstallation,
  detected: DetectedSource,
): Promise<RuntimeProfile | undefined> {
  if (!detected.runtimeProfile) return undefined
  const resolver = (storage as StorageWithRuntimeExtensions).runtimeProfiles
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

  // 一条来源记录及其派生的 Canonical Observation 属于同一持久化单元。
  // 除了保证原子性，也避免冷导入时每次仓储写入都单独开启 SQLite 事务。
  await storage.transaction(async () => {
    await storage.repositories.sourceRecords.put(persistedRecord)

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
  const derivedRelationships = deriveParentRelationshipCandidates(
    source.manifest.sourceId,
    installation.id,
    persistedOutput.observations,
  ).map(candidate => runtimeProfile ? { ...candidate, runtimeProfileId: runtimeProfile.id } : candidate)
  const relationshipCandidates = explicitRelationships.length ? explicitRelationships : derivedRelationships
  await persistRelationshipCandidates(storage, relationshipCandidates)

  for (const declaration of persistedOutput.coverage ?? []) {
    await coverage.declare(declaration)
  }

  return result
}

export class SourceHistoryRunner {
  constructor(
    private readonly storage: StorageService,
    private readonly identity: IdentityService,
    private readonly observations: ObservationService,
    private readonly capabilities: CapabilityService,
    private readonly coverage: CoverageService,
    private readonly capturePolicy: CapturePolicyService,
  ) {}

  async sync(input: SourceHistorySyncInput): Promise<SourceHistorySyncResult> {
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
      'history',
      runtimeProfile?.id,
    )

    try {
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

      const replay = this.storage.repositories.sourceRecords.listForParserReplay
      if (replay) {
        let after: { capturedAt: string; id: string } | undefined
        while (!abortSignal.aborted) {
          const records = await replay(
            source.manifest.sourceId,
            installation.id,
            source.manifest.parserVersion,
            after,
            500,
          )
          if (!records.length) break
          for (const stored of records) {
            if (abortSignal.aborted) break
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
            result.observationsCreated += processed.observationsCreated
            result.observationsMerged += processed.observationsMerged
            result.observationsUnchanged += processed.observationsUnchanged
          }
          const last = records.at(-1)!
          after = { capturedAt: last.capturedAt, id: last.id }
          if (records.length < 500) break
        }
      }

      if (!source.ingestHistory) {
        await markHealthy(this.storage, runtimeStatus)
        return result
      }

      const checkpoint = new ScopedCheckpointService(
        this.storage,
        checkpointScope(source.manifest.sourceId, installation.id, runtimeProfile),
      )
      let coverageFrom: string | undefined
      let coverageTo: string | undefined
      let coverageFromEvidence: EvidenceCandidate[] = []
      let coverageToEvidence: EvidenceCandidate[] = []
      const yieldForInteractivity = createCooperativeScheduler()

      for await (const record of source.ingestHistory({
        host,
        installation,
        ...(runtimeProfile ? { runtimeProfile } : {}),
        abortSignal,
        checkpoint,
        ...(input.historyWindow ? { historyWindow: input.historyWindow } : {}),
      })) {
        if (abortSignal.aborted) break
        result.records += 1
        const processed = await processSourceRecord(
          this.storage,
          this.observations,
          this.coverage,
          this.capturePolicy,
          source,
          host,
          installation,
          runtimeProfile,
          record,
        )
        result.observationsCreated += processed.observationsCreated
        result.observationsMerged += processed.observationsMerged
        result.observationsUnchanged += processed.observationsUnchanged

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

      await markHealthy(this.storage, runtimeStatus)
      return result
    } catch (error) {
      await markFailed(this.storage, runtimeStatus, error)
      throw error
    }
  }
}

export class SourceRuntimeRunner {
  constructor(
    private readonly storage: StorageService,
    private readonly identity: IdentityService,
    private readonly observations: ObservationService,
    private readonly capabilities: CapabilityService,
    private readonly coverage: CoverageService,
    private readonly capturePolicy: CapturePolicyService,
  ) {}

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
                await processSourceRecord(
                  this.storage,
                  this.observations,
                  this.coverage,
                  this.capturePolicy,
                  source,
                  host,
                  installation,
                  runtimeProfile,
                  record,
                )
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
      }
      if (!source.discoverAssets || !this.capturePolicy.isEnabled('config')) {
        await markHealthy(this.storage, runtimeStatus)
        return result
      }

      const checkpoint = new ScopedCheckpointService(
        this.storage,
        checkpointScope(source.manifest.sourceId, installation.id, runtimeProfile),
      )
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
          ...(safeDiscovered.binding?.path ? { path: safeDiscovered.binding.path } : {}),
          ...(safeDiscovered.binding?.source ? { source: safeDiscovered.binding.source } : {}),
          ...(safeDiscovered.binding?.version ? { version: safeDiscovered.binding.version } : {}),
        })
        result.assetsDiscovered += 1

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
          result.statesRecorded += 1
        }
        await yieldForInteractivity()
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
  createCooperativeScheduler,
  DEFAULT_COOPERATIVE_BUDGET_MS,
}
