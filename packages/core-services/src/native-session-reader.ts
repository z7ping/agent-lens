import type {
  CapturePolicyService,
  EvidenceCandidate,
  ObservationCandidate,
  SourceCheckpointService,
  SourceNativeSessionCursor,
  SourceService,
  StorageService,
} from '@agent-lens/core'
import type { NativeReaderWorkerPort } from './native-reader-worker-client'
import type { NativeWorkerNormalizedRecord } from './native-reader-worker-protocol'

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
      /** Ordered native record provenance per candidate, used for stable ephemeral DTO IDs. */
      observationRecordIds: string[]
      /** Optional exact native record boundary for each observation, trusted server-side only. */
      observationCursors?: SourceNativeSessionCursor[]
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
    private readonly nativeWorker?: NativeReaderWorkerPort,
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

    const sourceQuery = {
      filePath: catalog.filePath,
      nativeSessionId: catalog.nativeSessionId,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    }
    let nextCursor: SourceNativeSessionCursor
    let hasMore: boolean
    let pendingTail: boolean
    let normalizedRows: NativeWorkerNormalizedRecord[]

    if (this.nativeWorker?.supports(query.sourceId)) {
      // Native I/O and Source normalization are isolated in a bounded worker.
      // The parent keeps Catalog authority and the effective CapturePolicy.
      const result = await this.nativeWorker.read({
        sourceId: query.sourceId,
        parserVersion: source.manifest.parserVersion,
        expectedFileIdentity: catalog.fileIdentity,
        query: sourceQuery,
        host,
        installation,
      }, query.signal)
      if (result.state !== 'available') return result
      nextCursor = result.nextCursor
      hasMore = result.hasMore
      pendingTail = result.pendingTail
      normalizedRows = result.entries
    } else {
      // Unported Source integrations retain the current in-process reader.
      const result = await source.readNativeSessionPage(sourceQuery, {
        host, installation, abortSignal: query.signal, checkpoint: readOnlyCheckpoint,
      })
      if (result.state !== 'available') return result
      if (result.nextCursor.fileIdentity !== catalog.fileIdentity) {
        return { state: 'drifted', reason: 'native-catalog-file-identity-changed' }
      }
      nextCursor = result.nextCursor
      hasMore = result.hasMore
      pendingTail = result.pendingTail
      normalizedRows = []
      for (const [index, record] of result.records.entries()) {
        query.signal.throwIfAborted()
        if (record.installationId !== installation.id || record.sourceId !== query.sourceId
          || record.sourceSessionNativeId !== catalog.nativeSessionId) {
          return { state: 'drifted', reason: 'native-record-identity-changed' }
        }
        normalizedRows.push({
          recordId: record.id,
          ...(result.recordCursors?.[index] ? { recordCursor: result.recordCursors[index] } : {}),
          sourceId: record.sourceId,
          installationId: record.installationId,
          ...(record.sourceSessionNativeId ? { sourceSessionNativeId: record.sourceSessionNativeId } : {}),
          normalized: await source.normalize(record, { host, installation }),
        })
      }
    }

    if (nextCursor.fileIdentity !== catalog.fileIdentity) {
      return { state: 'drifted', reason: 'native-catalog-file-identity-changed' }
    }

    const observations: ObservationCandidate[] = []
    const observationRecordIds: string[] = []
    const observationCursors: SourceNativeSessionCursor[] = []
    let allRecordCursors = true
    const evidenceCandidates: EvidenceCandidate[] = []
    for (const row of normalizedRows) {
      query.signal.throwIfAborted()
      if (row.installationId !== installation.id || row.sourceId !== query.sourceId
        || row.sourceSessionNativeId !== catalog.nativeSessionId) {
        return { state: 'drifted', reason: 'native-record-identity-changed' }
      }
      if (row.recordCursor) {
        const fromOffset = query.cursor?.offset ?? 0
        if (row.recordCursor.fileIdentity !== catalog.fileIdentity
          || !Number.isSafeInteger(row.recordCursor.offset)
          || row.recordCursor.offset < fromOffset
          || row.recordCursor.offset >= nextCursor.offset
          || !Number.isSafeInteger(row.recordCursor.sequence)
          || row.recordCursor.sequence < 0) {
          return { state: 'drifted', reason: 'native-record-cursor-invalid' }
        }
      } else {
        allRecordCursors = false
      }
      const sanitized = this.capturePolicy.sanitizeNormalizedOutput(row.normalized)
      observations.push(...sanitized.observations)
      observationRecordIds.push(...sanitized.observations.map(() => row.recordId))
      if (row.recordCursor) {
        observationCursors.push(...sanitized.observations.map(() => row.recordCursor!))
      }
      evidenceCandidates.push(...sanitized.evidenceCandidates)
    }

    return {
      state: 'available',
      observations,
      observationRecordIds,
      ...(allRecordCursors ? { observationCursors } : {}),
      evidenceCandidates,
      nextCursor,
      hasMore,
      pendingTail,
    }
  }
}
