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

export type NativeArchivedHookReadResult =
  | { state: 'available'; observations: ObservationCandidate[];
      observationRecordIds: string[]; truncated: boolean }
  | { state: 'unavailable' | 'drifted' | 'unsupported'; reason: string }

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

  /** Hook-only source lane: never reads a client-supplied path, does not
   * advance capture checkpoints, and never returns raw Hook/Evidence payloads.
   * It is not a complete-turn history reader or a replacement for legacy
   * runtime-hook projections until the TaskSurface merge is verified.
   */
  async readArchivedHooks(query: {
    sourceId: string; installationId: string; nativeSessionId: string;
    signal: AbortSignal
  }): Promise<NativeArchivedHookReadResult> {
    if (!this.capturePolicy.isSourceEnabled(query.sourceId)) {
      return { state: 'unsupported', reason: 'source-disabled' }
    }
    query.signal.throwIfAborted()
    const catalog = await this.storage.nativeSessionCatalog?.get({
      sourceId: query.sourceId, installationId: query.installationId,
      nativeSessionId: query.nativeSessionId, locationKind: 'native',
    })
    if (!catalog) return { state: 'unavailable', reason: 'native-session-not-indexed' }
    const source = this.sources.list().find(definition =>
      definition.manifest.sourceId === query.sourceId)
    if (!source?.readArchivedNativeHooks) {
      return { state: 'unsupported', reason: 'native-hook-archive-source-unavailable' }
    }
    const installation = await this.storage.repositories.installations.get(query.installationId)
    if (!installation || installation.productId !== source.manifest.productId) {
      return { state: 'drifted', reason: 'native-installation-identity-changed' }
    }
    const host = await this.storage.repositories.hosts.get(installation.hostId)
    if (!host) return { state: 'unavailable', reason: 'native-source-host-unavailable' }
    const records = await source.readArchivedNativeHooks(query.nativeSessionId, {
      host, installation, abortSignal: query.signal, checkpoint: readOnlyCheckpoint,
    })
    // A Source can emit at most sixteen bounded Hook records for one page.
    if (records.length > 16) {
      return {state:'unsupported',reason:'native-hook-archive-page-too-large'}
    }
    const observations: ObservationCandidate[] = []
    const observationRecordIds: string[] = []
    for (const record of records) {
      query.signal.throwIfAborted()
      if (record.sourceId !== query.sourceId
        || record.installationId !== installation.id
        || record.sourceSessionNativeId !== query.nativeSessionId
        || record.locator.kind !== 'runtime-hook') {
        return { state: 'drifted', reason: 'native-hook-record-identity-drifted' }
      }
      const normalized = this.capturePolicy.sanitizeNormalizedOutput(
        await source.normalize(record, {host, installation}))
      for (const observation of normalized.observations) {
        observations.push(observation)
        observationRecordIds.push(record.id)
      }
    }
    let candidateBytes: number
    try { candidateBytes = Buffer.byteLength(JSON.stringify(observations), 'utf8') }
    catch { return {state:'unsupported',reason:'native-hook-payload-invalid'} }
    if (candidateBytes > 2 * 1024 * 1024) {
      return {state:'unsupported',reason:'native-hook-payload-too-large'}
    }
    return {
      state: 'available', observations, observationRecordIds,
      truncated: records.length === 16,
    }
  }

  /**
   * Attachment-only Source rehydration. Unlike read(), this transient result
   * retains original inline media bytes solely for the bounded HTTP attachment
   * extractor. It MUST NOT be used for Review content or persisted to SQLite.
   * Source-owned root, file identity, session identity and record rewind points
   * are verified again before returning any candidate.
   */
  async readUnpersistedMediaPage(query: NativeSessionReadQuery): Promise<NativeSessionReadResult> {
    if (!this.capturePolicy.isSourceEnabled(query.sourceId) || !this.capturePolicy.isEnabled('prompt')) {
      return {state:'unsupported',reason:'native-attachment-capture-disabled'}
    }
    const catalog = await this.storage.nativeSessionCatalog?.get({
      sourceId:query.sourceId,installationId:query.installationId,
      nativeSessionId:query.nativeSessionId,locationKind:'native',
    })
    if (!catalog) return {state:'unavailable',reason:'native-session-not-indexed'}
    const source=this.sources.list().find(item=>item.manifest.sourceId===query.sourceId)
    if (!source?.readNativeSessionPage) return {state:'unsupported',reason:'native-attachment-source-unavailable'}
    const installation=await this.storage.repositories.installations.get(query.installationId)
    if (!installation || installation.productId!==source.manifest.productId) {
      return {state:'drifted',reason:'native-installation-identity-changed'}
    }
    const host=await this.storage.repositories.hosts.get(installation.hostId)
    if (!host) return {state:'unavailable',reason:'native-source-host-unavailable'}
    if (!query.cursor || !Number.isSafeInteger(query.cursor.offset)
      || query.cursor.offset<0 || query.cursor.fileIdentity!==catalog.fileIdentity) {
      return {state:'unsupported',reason:'native-attachment-cursor-invalid'}
    }
    query.signal.throwIfAborted()
    const page=await source.readNativeSessionPage({
      filePath:catalog.filePath,nativeSessionId:catalog.nativeSessionId,
      cursor:query.cursor,limit:1,
    },{host,installation,abortSignal:query.signal,checkpoint:readOnlyCheckpoint})
    if (page.state!=='available') return page
    if (page.nextCursor.fileIdentity!==catalog.fileIdentity
      || !page.recordCursors || page.recordCursors.length!==page.records.length
      || page.records.length!==1 || page.pendingTail) {
      return {state:'drifted',reason:'native-attachment-record-identity-changed'}
    }
    const record=page.records[0]!
    const cursor=page.recordCursors[0]!
    if (record.sourceId!==query.sourceId || record.installationId!==installation.id
      || record.sourceSessionNativeId!==catalog.nativeSessionId
      || record.locator.path!==catalog.filePath
      || cursor.offset!==query.cursor.offset || cursor.sequence!==query.cursor.sequence
      || cursor.fileIdentity!==catalog.fileIdentity || !record.fingerprint) {
      return {state:'drifted',reason:'native-attachment-record-cursor-drifted'}
    }
    // Process one verified native record at a time. Raw prompt/tool text never
    // enters the HTTP DTO: only the endpoint's media extractor may consume it.
    // The attachment-only route deliberately sees unredacted inline media.
    // Limit its transient allocations separately from the public HTTP response.
    // Do not serialize or return an unbounded source payload to the web layer.
    let sourceBytes: number
    try {
      sourceBytes = Buffer.byteLength(JSON.stringify(record.payload), 'utf8')
    } catch {
      return {state:'unsupported',reason:'native-attachment-source-payload-invalid'}
    }
    if (sourceBytes > 3 * 1024 * 1024) {
      return {state:'unsupported',reason:'native-attachment-source-payload-too-large'}
    }
    const normalized=await source.normalize(record,{host,installation})
    query.signal.throwIfAborted()
    let normalizedBytes: number
    try {
      normalizedBytes = Buffer.byteLength(JSON.stringify(normalized.observations), 'utf8')
    } catch {
      return {state:'unsupported',reason:'native-attachment-normalized-payload-invalid'}
    }
    if (normalizedBytes > 3 * 1024 * 1024) {
      return {state:'unsupported',reason:'native-attachment-normalized-payload-too-large'}
    }
    return {
      state:'available',
      observations:normalized.observations,
      observationRecordIds:normalized.observations.map(()=>record.id),
      observationCursors:normalized.observations.map(()=>cursor),
      evidenceCandidates:[],
      nextCursor:page.nextCursor,hasMore:page.hasMore,pendingTail:false,
    }
  }

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
