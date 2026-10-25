import type {
  CapturePolicyService,
  EvidenceCandidate,
  ObservationCandidate,
  SourceCheckpointService,
  SourceNativeSessionCursor,
  SourceService,
  StorageService,
} from '@agent-lens/core'

/** Read-only checkpoint to ensure native review cannot update ingestion state. */
const readOnlyCheckpoint: SourceCheckpointService = {
  async get() { return null },
  async set() { throw new Error('Native Session Reader cannot persist source checkpoints') },
  async clear() { throw new Error('Native Session Reader cannot remove source checkpoints') },
}

export interface NativeSessionReadQuery {
  sourceId: string
  installationId: string
  nativeSessionId: string
  cursor?: SourceNativeSessionCursor
  limit?: number
  signal: AbortSignal
}

/**
 * Runtime Canonical candidates. Never persisted or used to advance history
 * checkpoints. The Task Surface renderer will consume these in its window DTO.
 */
export type NativeSessionReadResult =
  | {
      state: 'available'
      observations: ObservationCandidate[]
      evidenceCandidates: EvidenceCandidate[]
      nextCursor: SourceNativeSessionCursor
      hasMore: boolean
      pendingTail: boolean
    }
  | {
      state: 'unavailable' | 'drifted' | 'unsupported'
      reason: string
    }

/**
 * Resolves a source-authorized native window through the metadata-only catalog.
 * No caller-provided path is accepted; sources still perform independent root
 * validation. Privacy sanitization happens BEFORE the candidates are returned.
 */
export class NativeSessionReader {
  constructor(
    private readonly storage: StorageService,
    private readonly sources: SourceService,
    private readonly capturePolicy: CapturePolicyService,
  ) {}

  async read(query: NativeSessionReadQuery): Promise<NativeSessionReadResult> {
    if (!this.capturePolicy.isSourceEnabled(query.sourceId)) {
      return { state: 'unsupported', reason: 'source-disabled' }
    }
    if (!this.storage.nativeSessionCatalog) {
      return { state: 'unsupported', reason: 'native-session-catalog-unavailable' }
    }
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 64)) {
      return { state: 'unsupported', reason: 'native-window-limit-invalid' }
    }
    query.signal.throwIfAborted()

    const catalog = await this.storage.nativeSessionCatalog.get({
      sourceId: query.sourceId,
      installationId: query.installationId,
      nativeSessionId: query.nativeSessionId,
      locationKind: 'native',
    })
    if (!catalog) return { state: 'unavailable', reason: 'native-session-not-indexed' }

    const source = this.sources.list().find(definition => definition.manifest.sourceId === query.sourceId)
    if (!source?.readNativeSessionPage) {
      return { state: 'unsupported', reason: 'native-window-unsupported-by-source' }
    }
    const installation = await this.storage.repositories.installations.get(query.installationId)
    if (!installation || installation.productId !== source.manifest.productId) {
      return { state: 'drifted', reason: 'native-installation-identity-changed' }
    }
    const host = await this.storage.repositories.hosts.get(installation.hostId)
    if (!host) return { state: 'unavailable', reason: 'native-source-host-unavailable' }

    const result = await source.readNativeSessionPage(
      {
        filePath: catalog.filePath,
        nativeSessionId: catalog.nativeSessionId,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      },
      {
        host,
        installation,
        abortSignal: query.signal,
        checkpoint: readOnlyCheckpoint,
      },
    )
    if (result.state !== 'available') return result

    // A replaced file with the same path/native session id is not the same
    // catalogued source. An append to the same file keeps the identity.
    if (result.nextCursor.fileIdentity !== catalog.fileIdentity) {
      return { state: 'drifted', reason: 'native-catalog-file-identity-changed' }
    }

    const observations: ObservationCandidate[] = []
    const evidenceCandidates: EvidenceCandidate[] = []
    for (const record of result.records) {
      query.signal.throwIfAborted()
      if (record.installationId !== installation.id || record.sourceId !== query.sourceId
        || record.sourceSessionNativeId !== catalog.nativeSessionId) {
        return { state: 'drifted', reason: 'native-record-identity-changed' }
      }
      // Reuse the existing Source normalizer, but never call the ingestion
      // service. Payload stays in memory and is not cached by this reader.
      const normalized = await source.normalize(record, { host, installation })
      const sanitized = this.capturePolicy.sanitizeNormalizedOutput(normalized)
      observations.push(...sanitized.observations)
      evidenceCandidates.push(...sanitized.evidenceCandidates)
    }

    return {
      state: 'available',
      observations,
      evidenceCandidates,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      pendingTail: result.pendingTail,
    }
  }
}
