import type {
  AgentInstallation,
  AssetService,
  CapabilityService,
  CapturePolicyService,
  CoverageService,
  DetectedSource,
  Disposable,
  EvidenceService,
  Host,
  IdentityService,
  ObservationService,
  SourceCheckpointService,
  SourceDefinition,
  SourceRecord,
  StorageService,
} from '@agent-lens/core'

export interface SourceHistorySyncInput {
  source: SourceDefinition
  host: Host
  detected: DetectedSource
  abortSignal: AbortSignal
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

async function processSourceRecord(
  storage: StorageService,
  observations: ObservationService,
  coverage: CoverageService,
  capturePolicy: CapturePolicyService,
  source: SourceDefinition,
  host: Host,
  installation: AgentInstallation,
  record: SourceRecord,
): Promise<ProcessResult> {
  let normalized
  try {
    normalized = await source.normalize(record, { host, installation })
  } catch (error) {
    // Preserve the ingest/evidence unit for diagnostics, but never persist an
    // unsanitized native payload when normalization itself fails.
    await storage.repositories.sourceRecords.put(capturePolicy.sanitizeSourceRecord(record))
    throw error
  }

  const persistedRecord = capturePolicy.sanitizeSourceRecord(record, normalized)
  const persistedOutput = capturePolicy.sanitizeNormalizedOutput(normalized)
  await storage.repositories.sourceRecords.put(persistedRecord)

  const result: ProcessResult = {
    observationsCreated: 0,
    observationsMerged: 0,
    observationsUnchanged: 0,
  }

  for (const observation of persistedOutput.observations) {
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
      throw new Error(
        `Source mismatch: definition=${source.manifest.sourceId}, detected=${detected.sourceId}`,
      )
    }

    const installation = await resolveInstallation(this.identity, host, detected)
    const declaredCapabilities = await source.declareCapabilities(detected)
    this.capabilities.registerSourceCapabilities(
      source.manifest.sourceId,
      declaredCapabilities,
    )

    const result: SourceHistorySyncResult = {
      sourceId: source.manifest.sourceId,
      installationId: installation.id,
      records: 0,
      observationsCreated: 0,
      observationsMerged: 0,
      observationsUnchanged: 0,
    }

    if (!source.ingestHistory) return result

    const checkpoint = new ScopedCheckpointService(
      this.storage,
      `${source.manifest.sourceId}:${installation.id}`,
    )
    let coverageFrom: string | undefined
    let coverageTo: string | undefined

    for await (const record of source.ingestHistory({
      host,
      installation,
      abortSignal,
      checkpoint,
    })) {
      if (abortSignal.aborted) break

      result.records += 1
      const time = record.occurredAt ?? record.capturedAt
      coverageFrom = earlier(coverageFrom, time)
      coverageTo = later(coverageTo, time)

      const processed = await processSourceRecord(
        this.storage,
        this.observations,
        this.coverage,
        this.capturePolicy,
        source,
        host,
        installation,
        record,
      )
      result.observationsCreated += processed.observationsCreated
      result.observationsMerged += processed.observationsMerged
      result.observationsUnchanged += processed.observationsUnchanged
    }

    if (!abortSignal.aborted) {
      for (const capability of declaredCapabilities) {
        if (capability.status === 'unavailable' || capability.status === 'not-applicable') {
          await this.coverage.declare({
            subjectType: 'AgentInstallation',
            subjectId: installation.id,
            capability: capability.name,
            status: 'unavailable',
            reason: capability.reason ?? `Source reports capability as ${capability.status}`,
          })
          continue
        }

        if (!coverageFrom || !coverageTo) continue
        await this.coverage.declare({
          subjectType: 'AgentInstallation',
          subjectId: installation.id,
          capability: capability.name,
          from: coverageFrom,
          to: coverageTo,
          status: capability.status === 'available' ? 'complete' : 'partial',
          ...(capability.reason ? { reason: capability.reason } : {}),
        })
      }
    }

    return result
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
      throw new Error(
        `Source mismatch: definition=${source.manifest.sourceId}, detected=${detected.sourceId}`,
      )
    }

    const installation = await resolveInstallation(this.identity, host, detected)
    const declaredCapabilities = await source.declareCapabilities(detected)
    const capabilityRegistration = this.capabilities.registerSourceCapabilities(
      source.manifest.sourceId,
      declaredCapabilities,
    )

    if (!source.startCapture) {
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
      `${source.manifest.sourceId}:${installation.id}`,
    )
    let closed = false
    let tail: Promise<void> = Promise.resolve()

    const capture = await source.startCapture(
      {
        host,
        installation,
        abortSignal,
        checkpoint,
      },
      {
        emit: (record) => {
          if (closed) throw new Error(`Source runtime is closed: ${source.manifest.sourceId}`)
          const task = tail.then(async () => {
            await processSourceRecord(
              this.storage,
              this.observations,
              this.coverage,
              this.capturePolicy,
              source,
              host,
              installation,
              record,
            )
          })
          tail = task.then(() => undefined, () => undefined)
          return task
        },
      },
    )

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
      throw new Error(
        `Source mismatch: definition=${source.manifest.sourceId}, detected=${detected.sourceId}`,
      )
    }

    const installation = await resolveInstallation(this.identity, host, detected)
    const declaredCapabilities = await source.declareCapabilities(detected)
    this.capabilities.registerSourceCapabilities(
      source.manifest.sourceId,
      declaredCapabilities,
    )

    const result: SourceAssetDiscoveryResult = {
      sourceId: source.manifest.sourceId,
      installationId: installation.id,
      assetsDiscovered: 0,
      statesRecorded: 0,
    }
    if (!source.discoverAssets || !this.capturePolicy.isEnabled('config')) return result

    const checkpoint = new ScopedCheckpointService(
      this.storage,
      `${source.manifest.sourceId}:${installation.id}`,
    )

    for await (const discovered of source.discoverAssets({
      host,
      installation,
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
    }

    return result
  }
}
