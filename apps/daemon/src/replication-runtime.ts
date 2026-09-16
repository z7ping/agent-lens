import {
  canonicalReplicationReaderFromRepositories,
  pumpIndependentRootRuntimeStep,
  pumpObservationReplicationRuntimeStep,
} from '@agent-lens/replication-node'
import {
  INDEPENDENT_REPLICATION_ROOT_ENTITY_TYPES,
} from '@agent-lens/core/replication'
import {
  SqliteReplicationReconciliationSink,
} from '@agent-lens/storage-sqlite'
import type { DataRuntimeStorageService } from './data-runtime/storage-proxy.js'

const DEFAULT_PAGE_LIMIT = 100
const DEFAULT_GC_LIMIT = 500
const DEFAULT_RECONCILIATION_INTERVAL_MS = 30 * 60 * 1000
const ACTIVE_DELAY_MS = 500
const IDLE_DELAY_MS = 15_000
const ERROR_DELAY_MS = 5_000

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    const onAbort = () => done()
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface ReplicationMaintenanceLoopOptions {
  storage: DataRuntimeStorageService
  nodeId: string
  replicationUpstream: boolean
  signal: AbortSignal
  cooperate?: () => Promise<void>
  pageLimit?: number
  gcLimit?: number
  journalGcEnabled?: boolean
  reconciliationIntervalMs?: number
  onInfo?: (message: string) => void
  onError?: (error: unknown) => void
}

/**
 * Daemon composition loop for Node-side replication state maintenance.
 *
 * Transport remains out of scope: this loop only turns persisted stream
 * authorization into Durable Pending/Frozen-ready state and keeps the local
 * journal reclaimable. Destructive journal GC is deliberately gated and
 * defaults off while ADR-0010 remains proposed.
 */
export async function runReplicationMaintenanceLoop(
  options: ReplicationMaintenanceLoopOptions,
): Promise<void> {
  const {
    storage,
    nodeId,
    replicationUpstream,
    signal,
  } = options
  const dependencies = canonicalReplicationReaderFromRepositories(
    storage.repositories,
    storage.runtimeProfiles,
  )
  const reconciliationSink = new SqliteReplicationReconciliationSink(storage.replication)
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT
  const gcLimit = options.gcLimit ?? DEFAULT_GC_LIMIT
  const reconciliationIntervalMs =
    options.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS
  const journalGcEnabled = options.journalGcEnabled ?? false

  while (!signal.aborted) {
    let didWork = false
    try {
      await options.cooperate?.()
      if (signal.aborted) return

      const streams = replicationUpstream
        ? await storage.replicationRuntimeControl.listRunnableStreams()
        : []

      for (const item of streams) {
        if (signal.aborted) return
        await options.cooperate?.()
        if (signal.aborted) return

        const result = await pumpObservationReplicationRuntimeStep({
          changes: storage.replicationCanonicalChanges,
          snapshot: storage.replicationObservationSnapshot,
          observations: storage.repositories.observations,
          dependencies,
          pendingSink: storage.replication,
          reconciliationSink,
          snapshotProgress: storage.replicationSnapshotBootstrapProgress,
          deltaProgress: storage.replicationChangeProgress,
          incrementalProgress: storage.replicationChangeProgress,
          captureProgress: storage.replicationJournalLifecycle,
          lifecycle: storage.replicationBootstrapLifecycle,
          cycles: storage.replicationRuntimeControl,
          nodeId,
          streamId: item.stream.streamId,
          generationId: item.stream.generationId,
          policy: item.authorization.policy,
          history: item.authorization.history,
          pageLimit,
          reconciliationIntervalMs,
        })

        let allRootsActive = result.kind === 'active'
        let streamDidWork = result.didWork
        for (const entityType of INDEPENDENT_REPLICATION_ROOT_ENTITY_TYPES) {
          if (signal.aborted) return
          await options.cooperate?.()
          if (signal.aborted) return
          const independentResult = await pumpIndependentRootRuntimeStep({
            entityType,
            changes: storage.replicationCanonicalChanges,
            roots: storage.replicationIndependentRoots,
            dependencies,
            pendingSink: storage.replication,
            reconciliationSink,
            snapshotProgress: storage.replicationSnapshotBootstrapProgress,
            deltaProgress: storage.replicationChangeProgress,
            incrementalProgress: storage.replicationChangeProgress,
            captureProgress: storage.replicationJournalLifecycle,
            lifecycle: storage.replicationBootstrapLifecycle,
            cycles: storage.replicationRuntimeControl,
            nodeId,
            streamId: item.stream.streamId,
            generationId: item.stream.generationId,
            policy: item.authorization.policy,
            history: item.authorization.history,
            pageLimit,
            reconciliationIntervalMs,
          })
          allRootsActive = allRootsActive && independentResult.kind === 'active'
          streamDidWork = streamDidWork || independentResult.didWork
        }

        if (journalGcEnabled && allRootsActive) {
          const reclaimed = await storage.replicationJournalLifecycle.reclaimBatch({ limit: gcLimit })
          if (reclaimed.deletedChanges > 0) {
            streamDidWork = true
            options.onInfo?.(
              `replication journal reclaimed=${reclaimed.deletedChanges} safeRevision=${reclaimed.safeJournalRevision}`,
            )
          }
        }
        didWork = didWork || streamDidWork
      }

      if (!didWork && journalGcEnabled) {
        const reclaimed = await storage.replicationJournalLifecycle.reclaimBatch({ limit: gcLimit })
        if (reclaimed.deletedChanges > 0) {
          options.onInfo?.(
            `replication journal reclaimed=${reclaimed.deletedChanges} safeRevision=${reclaimed.safeJournalRevision}`,
          )
          didWork = true
        }
      }
    } catch (error) {
      options.onError?.(error)
      await abortableDelay(ERROR_DELAY_MS, signal)
      continue
    }

    await abortableDelay(didWork ? ACTIVE_DELAY_MS : IDLE_DELAY_MS, signal)
  }
}
