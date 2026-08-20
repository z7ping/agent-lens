import type {
  CapabilityService,
  CoverageService,
  DetectedSource,
  Host,
  IdentityService,
  ObservationService,
  SourceCheckpointService,
  SourceDefinition,
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

class ScopedCheckpointService implements SourceCheckpointService {
  constructor(
    private readonly storage: StorageService,
    private readonly scope: string,
  ) {}

  get<T>(key: string): Promise<T | null> {
    return this.storage.checkpoints.get<T>(this.scope, key)
  }

  set<T>(key: string, value: T): Promise<void> {
    return this.storage.checkpoints.set(this.scope, key, value)
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

export class SourceHistoryRunner {
  constructor(
    private readonly storage: StorageService,
    private readonly identity: IdentityService,
    private readonly observations: ObservationService,
    private readonly capabilities: CapabilityService,
    private readonly coverage: CoverageService,
  ) {}

  async sync(input: SourceHistorySyncInput): Promise<SourceHistorySyncResult> {
    const { source, host, detected, abortSignal } = input
    if (source.manifest.sourceId !== detected.sourceId) {
      throw new Error(
        `Source mismatch: definition=${source.manifest.sourceId}, detected=${detected.sourceId}`,
      )
    }

    const installation = await this.identity.resolveInstallation({
      hostId: host.id,
      productId: detected.productId,
      ...(detected.executable ? { executable: detected.executable } : {}),
      ...(detected.version ? { version: detected.version } : {}),
      ...(detected.configRoot ? { configRoot: detected.configRoot } : {}),
      ...(detected.dataRoot ? { dataRoot: detected.dataRoot } : {}),
    })

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

      await this.storage.repositories.sourceRecords.put(record)
      result.records += 1

      const time = record.occurredAt ?? record.capturedAt
      coverageFrom = earlier(coverageFrom, time)
      coverageTo = later(coverageTo, time)

      const normalized = await source.normalize(record, { host, installation })
      for (const observation of normalized.observations) {
        const committed = await this.observations.commit({
          sourceId: source.manifest.sourceId,
          host,
          installation,
          candidate: observation,
          // NormalizedSourceOutput evidence is SourceRecord-scoped and therefore
          // applies to every candidate emitted from that SourceRecord.
          evidenceCandidates: normalized.evidenceCandidates,
        })

        if (committed.status === 'created') result.observationsCreated += 1
        else if (committed.status === 'merged') result.observationsMerged += 1
        else result.observationsUnchanged += 1
      }

      for (const declaration of normalized.coverage ?? []) {
        await this.coverage.declare(declaration)
      }
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
