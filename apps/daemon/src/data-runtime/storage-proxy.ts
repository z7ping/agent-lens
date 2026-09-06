import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  AssetInventoryReader,
  CheckpointRepository,
  MaintenanceJobStore,
  RepositorySet,
  SessionSummaryProjectionStore,
  StorageHealth,
  StorageService,
  StorageTransaction,
  ToolUsageObservationReader,
} from '@agent-lens/core'
import type { UnifiedReadService } from '@agent-lens/core/replication'
import { DataRuntimeClient, type DataRuntimeClientSnapshot } from './client.js'
import { DATA_RUNTIME_MAX_PENDING_REQUESTS } from './protocol.js'

const WRITE_TIMEOUT_MS = 30_000
const MAINTENANCE_TIMEOUT_MS = 120_000
const READ_TIMEOUT_MS = 2_000
const RECOVERY_INTERVAL_MS = 2_000
const READER_RESERVED_PENDING = 1
const FOREGROUND_QUEUE_MAX = 256
const FOREGROUND_QUEUE_WAIT_MS = 1_500
const FOREGROUND_QUEUE_POLL_MS = 2

const READ_PREFIXES = [
  'get',
  'list',
  'query',
  'find',
  'summary',
  'aggregate',
  'health',
  'diagnostics',
  'isMaterialized',
  'audit',
  'overview',
  'preview',
  'verify',
  'facetScope',
  'toolUsageFactCoverage',
  'toolUsageFactCoverageForMaintenance',
  'repairToolUsageFactCursor',
] as const

function isReadPath(path: readonly string[]): boolean {
  const method = path.at(-1) ?? ''
  return READ_PREFIXES.some(prefix => method.startsWith(prefix))
}

function isMaintenanceReadPath(path: readonly string[]): boolean {
  const method = path.at(-1) ?? ''
  return path[0] === 'diagnostics'
    || method === 'listForParserReplay'
    || method === 'toolUsageFactCoverageForMaintenance'
    || method === 'repairToolUsageFactCursor'
    || method.startsWith('audit')
}

function isMaintenanceOperation(path: readonly string[]): boolean {
  const method = path.at(-1) ?? ''
  return path.includes('maintenance')
    || isMaintenanceReadPath(path)
    || (path.includes('projectionBackfill') && method.startsWith('backfill'))
}

function timeoutFor(path: readonly string[], read: boolean): number {
  if (isMaintenanceOperation(path)) return MAINTENANCE_TIMEOUT_MS
  return read ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS
}

function logicalReaderSnapshot(client: DataRuntimeClient): DataRuntimeClientSnapshot {
  const snapshot = client.snapshot()
  return snapshot.role === 'reader' ? snapshot : { ...snapshot, role: 'reader' }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class DataRuntimeReaderPool {
  private cursor = 0
  private queued = 0
  private maxQueued = 0
  private overloads = 0
  private queueTimeouts = 0

  constructor(readonly readers: readonly DataRuntimeClient[]) {
    if (!readers.length) throw new Error('Data Runtime Reader Pool requires at least one reader')
  }

  async request<T>(method: Parameters<DataRuntimeClient['request']>[0], params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const immediate = this.pickAvailable()
    if (immediate) return immediate.request<T>(method, params, timeoutMs)

    if (this.queued >= FOREGROUND_QUEUE_MAX) {
      this.overloads += 1
      throw new Error('Data Runtime reader pool overload queue limit reached')
    }

    this.queued += 1
    this.maxQueued = Math.max(this.maxQueued, this.queued)
    const startedAt = performance.now()
    const waitBudgetMs = Math.min(timeoutMs, FOREGROUND_QUEUE_WAIT_MS)
    try {
      while (performance.now() - startedAt < waitBudgetMs) {
        const reader = this.pickAvailable()
        if (reader) {
          const elapsed = performance.now() - startedAt
          return reader.request<T>(method, params, Math.max(1, timeoutMs - elapsed))
        }
        await delay(FOREGROUND_QUEUE_POLL_MS)
      }
      this.queueTimeouts += 1
      throw new Error('Data Runtime reader pool queue wait timed out')
    } finally {
      this.queued -= 1
    }
  }

  snapshots(): DataRuntimeClientSnapshot[] {
    return this.readers.map(logicalReaderSnapshot)
  }

  queueSnapshot() {
    return {
      queued: this.queued,
      maxQueued: this.maxQueued,
      maxQueue: FOREGROUND_QUEUE_MAX,
      overloads: this.overloads,
      queueTimeouts: this.queueTimeouts,
      waitBudgetMs: FOREGROUND_QUEUE_WAIT_MS,
    }
  }

  readyCount(): number {
    return this.readers.filter(reader => reader.state() === 'ready').length
  }

  pending(): number {
    return this.snapshots().reduce((sum, item) => sum + item.pending, 0)
  }

  private pickAvailable(): DataRuntimeClient | undefined {
    const ready = this.readers.filter(reader => reader.state() === 'ready')
    const capacity = DATA_RUNTIME_MAX_PENDING_REQUESTS - READER_RESERVED_PENDING
    const candidates = ready.filter(reader => reader.snapshot().pending < capacity)
    if (!candidates.length) return undefined
    let bestPending = Number.POSITIVE_INFINITY
    let best: DataRuntimeClient[] = []
    for (const reader of candidates) {
      const pending = reader.snapshot().pending
      if (pending < bestPending) {
        bestPending = pending
        best = [reader]
      } else if (pending === bestPending) {
        best.push(reader)
      }
    }
    const selected = best[this.cursor % best.length] ?? candidates[0]!
    this.cursor = (this.cursor + 1) % Number.MAX_SAFE_INTEGER
    return selected
  }
}

interface RemoteCallOptions {
  forceWriter?: boolean
  maintenanceRead?: boolean
}

class RemoteStorageExecutor {
  private readonly transactionScope = new AsyncLocalStorage<string>()
  private writerTail: Promise<void> = Promise.resolve()

  constructor(
    readonly writer: DataRuntimeClient,
    readonly foregroundReaders: DataRuntimeReaderPool,
    readonly maintenanceReader: DataRuntimeClient,
  ) {}

  async call<T>(
    path: readonly string[],
    args: readonly unknown[] = [],
    options: RemoteCallOptions = {},
  ): Promise<T> {
    const activeTransactionId = this.transactionScope.getStore()
    if (activeTransactionId) {
      return this.writer.request<T>('storage.call', {
        path: [...path],
        args: [...args],
        transactionId: activeTransactionId,
      }, timeoutFor(path, false))
    }

    const read = !options.forceWriter && isReadPath(path)
    if (read) {
      const params = { path: [...path], args: [...args] }
      if (options.maintenanceRead || isMaintenanceReadPath(path)) {
        return this.maintenanceReader.request<T>('storage.call', params, timeoutFor(path, true))
      }
      return this.foregroundReaders.request<T>('storage.call', params, timeoutFor(path, true))
    }

    return this.enqueueWriter(() => this.writer.request<T>('storage.call', {
      path: [...path],
      args: [...args],
    }, timeoutFor(path, false)))
  }

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.transactionScope.getStore()) return operation()
    return this.enqueueWriter(async () => {
      const opened = await this.writer.request<{ transactionId: string }>(
        'storage.transaction.begin',
        undefined,
        WRITE_TIMEOUT_MS,
      )
      try {
        const result = await this.transactionScope.run(opened.transactionId, operation)
        await this.writer.request(
          'storage.transaction.commit',
          { transactionId: opened.transactionId },
          WRITE_TIMEOUT_MS,
        )
        return result
      } catch (error) {
        await this.writer.request(
          'storage.transaction.rollback',
          { transactionId: opened.transactionId },
          WRITE_TIMEOUT_MS,
        ).catch(() => undefined)
        throw error
      }
    })
  }

  private enqueueWriter<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writerTail.then(operation, operation)
    this.writerTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function namespaceProxy<T extends object>(executor: RemoteStorageExecutor, path: readonly string[]): T {
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined
      if (typeof property !== 'string') return undefined
      return (...args: unknown[]) => executor.call([...path, property], args)
    },
  }) as T
}

interface SessionSummaryFacetScope {
  facetScope(): Promise<{
    projects: Array<{ id: string; name?: string; repositoryIdentity?: string }>
    from?: string
    to?: string
  }>
}

function sessionSummaryProxy(executor: RemoteStorageExecutor): SessionSummaryProjectionStore & SessionSummaryFacetScope {
  return {
    query: input => executor.call(['sessionSummaryProjection', 'query'], [input]),
    facetScope: () => executor.call(['sessionSummaryProjection', 'facetScope']),
    isMaterialized: () => executor.call(['sessionSummaryProjection', 'isMaterialized']),
    rebuild: input => {
      const portable = input
        ? {
            ...(input.logicalSessionId ? { logicalSessionId: input.logicalSessionId } : {}),
            ...(input.strategy ? { strategy: input.strategy } : {}),
          }
        : undefined
      return executor.call<void>(
        ['sessionSummaryProjection', 'rebuild'],
        portable ? [portable] : [],
        { forceWriter: true },
      )
    },
  }
}

export interface DataRuntimeHealthSnapshot {
  writer: DataRuntimeClientSnapshot
  reader: DataRuntimeClientSnapshot
  readers: DataRuntimeClientSnapshot[]
  maintenanceReader: DataRuntimeClientSnapshot
  foregroundQueue: ReturnType<DataRuntimeReaderPool['queueSnapshot']>
  ok: boolean
  recovering: boolean
}

export class DataRuntimeService {
  private recoveryTimer: NodeJS.Timeout | null = null
  private recovering = false
  private stopping = false

  constructor(
    readonly writer: DataRuntimeClient,
    readonly foregroundReaders: DataRuntimeReaderPool,
    readonly maintenanceReader: DataRuntimeClient,
  ) {}

  snapshot(): DataRuntimeHealthSnapshot {
    const writer = this.writer.snapshot()
    const readers = this.foregroundReaders.snapshots()
    const readyReaders = readers.filter(reader => reader.state === 'ready')
    const reader = (readyReaders.length ? readyReaders : readers)
      .slice()
      .sort((left, right) => left.pending - right.pending)[0]!
    const maintenanceReader = logicalReaderSnapshot(this.maintenanceReader)
    return {
      writer,
      reader,
      readers,
      maintenanceReader,
      foregroundQueue: this.foregroundReaders.queueSnapshot(),
      ok: writer.state === 'ready' && readyReaders.length > 0,
      recovering: this.recovering,
    }
  }

  foregroundPending(): number {
    return this.foregroundReaders.pending()
  }

  writerPending(): number {
    return this.writer.snapshot().pending
  }

  startRecovery(intervalMs = RECOVERY_INTERVAL_MS): void {
    if (this.recoveryTimer || this.stopping) return
    const tick = () => { void this.recover().catch(() => undefined) }
    this.recoveryTimer = setInterval(tick, Math.max(500, intervalMs))
    this.recoveryTimer.unref?.()
    tick()
  }

  async recover(): Promise<void> {
    if (this.stopping || this.recovering) return
    const writerNeedsRecovery = this.writer.state() !== 'ready'
    const readersNeedRecovery = this.foregroundReaders.readers.some(reader => reader !== this.writer && reader.state() !== 'ready')
    const maintenanceNeedsRecovery = this.maintenanceReader !== this.writer && this.maintenanceReader.state() !== 'ready'
    if (!writerNeedsRecovery && !readersNeedRecovery && !maintenanceNeedsRecovery) return

    this.recovering = true
    try {
      if (writerNeedsRecovery) await this.writer.start().catch(() => undefined)
      if (this.writer.state() === 'ready') {
        for (const reader of this.foregroundReaders.readers) {
          if (reader !== this.writer && reader.state() !== 'ready') await reader.start().catch(() => undefined)
        }
        if (this.maintenanceReader !== this.writer && this.maintenanceReader.state() !== 'ready') {
          await this.maintenanceReader.start().catch(() => undefined)
        }
      }
    } finally {
      this.recovering = false
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    if (this.recoveryTimer) clearInterval(this.recoveryTimer)
    this.recoveryTimer = null
    const unique = new Set<DataRuntimeClient>([
      ...this.foregroundReaders.readers,
      this.maintenanceReader,
      this.writer,
    ])
    for (const client of unique) await client.shutdown().catch(() => undefined)
  }
}

export class DataRuntimeStorageService implements StorageService {
  readonly repositories: RepositorySet
  readonly checkpoints: CheckpointRepository
  readonly assetInventory: AssetInventoryReader
  readonly sessionSummaries: SessionSummaryProjectionStore
  readonly sessionSummaryProjection: SessionSummaryProjectionStore
  readonly toolUsageObservations: ToolUsageObservationReader
  readonly unknownObservationProjection: any
  readonly maintenance: any
  readonly maintenanceJobs: MaintenanceJobStore
  readonly projectionBackfill: any
  readonly runtimeProfiles: any
  readonly sourceRuntimeStatus: any
  readonly sessionRelationshipCandidates: any
  readonly replication: any
  readonly replicationCanonicalChanges: any

  constructor(private readonly executor: RemoteStorageExecutor) {
    this.repositories = {
      hosts: namespaceProxy(executor, ['repositories', 'hosts']),
      installations: namespaceProxy(executor, ['repositories', 'installations']),
      sessions: namespaceProxy(executor, ['repositories', 'sessions']),
      sourceRecords: namespaceProxy(executor, ['repositories', 'sourceRecords']),
      observations: namespaceProxy(executor, ['repositories', 'observations']),
      evidence: namespaceProxy(executor, ['repositories', 'evidence']),
      coverage: namespaceProxy(executor, ['repositories', 'coverage']),
      assets: namespaceProxy(executor, ['repositories', 'assets']),
      tools: namespaceProxy(executor, ['repositories', 'tools']),
    }
    this.checkpoints = namespaceProxy(executor, ['checkpoints'])
    this.assetInventory = namespaceProxy(executor, ['assetInventory'])
    const summaries = sessionSummaryProxy(executor)
    this.sessionSummaries = summaries
    this.sessionSummaryProjection = summaries
    this.toolUsageObservations = namespaceProxy(executor, ['toolUsageObservations'])
    this.unknownObservationProjection = namespaceProxy(executor, ['unknownObservationProjection'])
    this.maintenance = namespaceProxy(executor, ['maintenance'])
    this.maintenanceJobs = namespaceProxy(executor, ['maintenanceJobs'])
    this.projectionBackfill = namespaceProxy(executor, ['projectionBackfill'])
    this.runtimeProfiles = namespaceProxy(executor, ['runtimeProfiles'])
    this.sourceRuntimeStatus = namespaceProxy(executor, ['sourceRuntimeStatus'])
    this.sessionRelationshipCandidates = namespaceProxy(executor, ['sessionRelationshipCandidates'])
    this.replication = namespaceProxy(executor, ['replication'])
    this.replicationCanonicalChanges = namespaceProxy(executor, ['replicationCanonicalChanges'])
  }

  transaction<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T> {
    return this.executor.transaction(() => fn(this.repositories))
  }

  async health(): Promise<StorageHealth> {
    if (this.executor.foregroundReaders.readyCount() > 0) return this.executor.call(['health'])
    if (this.executor.writer.state() === 'ready') return this.executor.call(['health'], [], { forceWriter: true })
    return {
      ok: false,
      details: {
        dataRuntimeUnavailable: true,
        writerState: this.executor.writer.state(),
        readerStates: this.executor.foregroundReaders.snapshots().map(item => item.state),
      },
    }
  }

  diagnostics(): Promise<StorageHealth> {
    return this.executor.call(['diagnostics'], [], { maintenanceRead: true })
  }
}

export class DataRuntimeUnifiedReadService implements UnifiedReadService {
  readonly logicalSessions: UnifiedReadService['logicalSessions']
  readonly observations: UnifiedReadService['observations']

  constructor(private readonly readers: DataRuntimeReaderPool) {
    this.logicalSessions = {
      get: publicId => this.call(['logicalSessions', 'get'], [publicId]),
      list: limit => this.call(['logicalSessions', 'list'], limit === undefined ? [] : [limit]),
    }
    this.observations = {
      queryForLogicalSession: (publicId, limit) => this.call(
        ['observations', 'queryForLogicalSession'],
        limit === undefined ? [publicId] : [publicId, limit],
      ),
    }
  }

  private call<T>(path: readonly string[], args: readonly unknown[]): Promise<T> {
    return this.readers.request<T>('unified-read.call', { path: [...path], args: [...args] }, READ_TIMEOUT_MS)
  }
}

export function createDataRuntimeStorage(
  writer: DataRuntimeClient,
  readers: readonly DataRuntimeClient[],
  maintenanceReader: DataRuntimeClient,
): {
  storage: DataRuntimeStorageService
  unifiedRead: DataRuntimeUnifiedReadService
  dataRuntime: DataRuntimeService
} {
  const foregroundReaders = new DataRuntimeReaderPool(readers)
  const executor = new RemoteStorageExecutor(writer, foregroundReaders, maintenanceReader)
  return {
    storage: new DataRuntimeStorageService(executor),
    unifiedRead: new DataRuntimeUnifiedReadService(foregroundReaders),
    dataRuntime: new DataRuntimeService(writer, foregroundReaders, maintenanceReader),
  }
}

export const dataRuntimeStorageInternals = {
  isReadPath,
  isMaintenanceReadPath,
  isMaintenanceOperation,
  timeoutFor,
  sessionSummaryProxy,
  READ_TIMEOUT_MS,
  WRITE_TIMEOUT_MS,
  MAINTENANCE_TIMEOUT_MS,
  RECOVERY_INTERVAL_MS,
  FOREGROUND_QUEUE_MAX,
  FOREGROUND_QUEUE_WAIT_MS,
  READER_RESERVED_PENDING,
}
