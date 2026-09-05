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

const WRITE_TIMEOUT_MS = 30_000
const MAINTENANCE_TIMEOUT_MS = 120_000
const READ_TIMEOUT_MS = 5_000
const RECOVERY_INTERVAL_MS = 2_000

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
] as const

function isReadPath(path: readonly string[]): boolean {
  const method = path.at(-1) ?? ''
  return READ_PREFIXES.some(prefix => method.startsWith(prefix))
}

function timeoutFor(path: readonly string[], read: boolean): number {
  if (path.includes('maintenance') || path.includes('projectionBackfill')) return MAINTENANCE_TIMEOUT_MS
  return read ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS
}

interface RemoteCallOptions {
  forceWriter?: boolean
}

class RemoteStorageExecutor {
  private readonly transactionScope = new AsyncLocalStorage<string>()
  private writerTail: Promise<void> = Promise.resolve()

  constructor(
    readonly writer: DataRuntimeClient,
    readonly reader: DataRuntimeClient,
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
      return this.reader.request<T>('storage.call', {
        path: [...path],
        args: [...args],
      }, timeoutFor(path, true))
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

function namespaceProxy<T extends object>(
  executor: RemoteStorageExecutor,
  path: readonly string[],
): T {
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined
      if (typeof property !== 'string') return undefined
      return (...args: unknown[]) => executor.call([...path, property], args)
    },
  }) as T
}

function sessionSummaryProxy(executor: RemoteStorageExecutor): SessionSummaryProjectionStore {
  return {
    query: input => executor.call(['sessionSummaryProjection', 'query'], [input]),
    isMaterialized: () => executor.call(['sessionSummaryProjection', 'isMaterialized']),
    rebuild: input => {
      const portable = input
        ? {
            ...(input.logicalSessionId ? { logicalSessionId: input.logicalSessionId } : {}),
            ...(input.strategy ? { strategy: input.strategy } : {}),
          }
        : undefined
      return executor.call(
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
  ok: boolean
  recovering: boolean
}

export class DataRuntimeService {
  private recoveryTimer: NodeJS.Timeout | null = null
  private recovering = false
  private stopping = false

  constructor(
    readonly writer: DataRuntimeClient,
    readonly reader: DataRuntimeClient,
  ) {}

  snapshot(): DataRuntimeHealthSnapshot {
    const writer = this.writer.snapshot()
    const reader = this.reader.snapshot()
    return {
      writer,
      reader,
      ok: writer.state === 'ready' && reader.state === 'ready',
      recovering: this.recovering,
    }
  }

  startRecovery(intervalMs = RECOVERY_INTERVAL_MS): void {
    if (this.recoveryTimer || this.stopping) return
    const tick = () => {
      void this.recover().catch(() => undefined)
    }
    this.recoveryTimer = setInterval(tick, Math.max(500, intervalMs))
    this.recoveryTimer.unref?.()
    tick()
  }

  async recover(): Promise<void> {
    if (this.stopping || this.recovering) return
    const writerNeedsRecovery = this.writer.state() !== 'ready'
    const readerNeedsRecovery = this.reader !== this.writer && this.reader.state() !== 'ready'
    if (!writerNeedsRecovery && !readerNeedsRecovery) return

    this.recovering = true
    try {
      if (writerNeedsRecovery) {
        await this.writer.start().catch(() => undefined)
      }
      if (this.writer.state() === 'ready' && readerNeedsRecovery) {
        await this.reader.start().catch(() => undefined)
      }
    } finally {
      this.recovering = false
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer)
      this.recoveryTimer = null
    }
    if (this.reader !== this.writer) await this.reader.shutdown().catch(() => undefined)
    await this.writer.shutdown().catch(() => undefined)
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
    if (this.executor.reader.state() === 'ready') {
      return this.executor.call(['health'])
    }
    if (this.executor.writer.state() === 'ready') {
      return this.executor.call(['health'], [], { forceWriter: true })
    }
    return {
      ok: false,
      details: {
        dataRuntimeUnavailable: true,
        writerState: this.executor.writer.state(),
        readerState: this.executor.reader.state(),
      },
    }
  }

  diagnostics(): Promise<StorageHealth> {
    return this.executor.call(['diagnostics'])
  }
}

export class DataRuntimeUnifiedReadService implements UnifiedReadService {
  readonly logicalSessions: UnifiedReadService['logicalSessions']
  readonly observations: UnifiedReadService['observations']

  constructor(private readonly reader: DataRuntimeClient) {
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
    return this.reader.request<T>('unified-read.call', {
      path: [...path],
      args: [...args],
    }, READ_TIMEOUT_MS)
  }
}

export function createDataRuntimeStorage(
  writer: DataRuntimeClient,
  reader: DataRuntimeClient,
): {
  storage: DataRuntimeStorageService
  unifiedRead: DataRuntimeUnifiedReadService
  dataRuntime: DataRuntimeService
} {
  const executor = new RemoteStorageExecutor(writer, reader)
  return {
    storage: new DataRuntimeStorageService(executor),
    unifiedRead: new DataRuntimeUnifiedReadService(reader),
    dataRuntime: new DataRuntimeService(writer, reader),
  }
}

export const dataRuntimeStorageInternals = {
  isReadPath,
  timeoutFor,
  sessionSummaryProxy,
  READ_TIMEOUT_MS,
  WRITE_TIMEOUT_MS,
  MAINTENANCE_TIMEOUT_MS,
  RECOVERY_INTERVAL_MS,
}
