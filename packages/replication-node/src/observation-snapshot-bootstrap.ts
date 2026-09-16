import type { CanonicalObservation } from '@agent-lens/core'
import type {
  HistoryBoundary,
  ReplicationPolicy,
} from '@agent-lens/core/replication'
import {
  generateObservationReplicaGraph,
  type CanonicalReplicationReader,
} from './canonical-graph'
import {
  captureReplicationHighWater,
  type CanonicalChangeSource,
} from './observation-change-pump'
import {
  enqueueWireGraph,
  type PendingCandidateSink,
} from './pending-sink'

export interface CanonicalObservationSnapshotPage {
  items: readonly CanonicalObservation[]
  nextCursor?: string
  done: boolean
}

export interface CanonicalObservationSnapshotSource {
  scan(input: {
    afterId?: string
    capturedAtOnOrAfter?: string
    limit?: number
  }): Promise<CanonicalObservationSnapshotPage>
}

export interface ObservationSnapshotBootstrapProgress {
  streamId: string
  generationId: string
  entityType: 'CanonicalObservation'
  baselineRevision: number
  cursor?: string
  snapshotComplete: boolean
  updatedAt: string
}

export interface ObservationSnapshotBootstrapProgressStore {
  get(input: {
    streamId: string
    generationId: string
    entityType: 'CanonicalObservation'
  }): Promise<ObservationSnapshotBootstrapProgress | null>
  put(progress: ObservationSnapshotBootstrapProgress): Promise<void>
}

export interface ObservationSnapshotBootstrapPageResult {
  initialized: boolean
  baselineRevision: number
  nextCursor?: string
  done: boolean
  observationCount: number
  blockedCount: number
  pending: {
    total: number
    created: number
    replaced: number
    unchanged: number
  }
}

function fromNowBoundary(history: HistoryBoundary): string | undefined {
  if (history.mode !== 'from-now') return undefined
  if (!history.boundaryCapturedAt || !Number.isFinite(Date.parse(history.boundaryCapturedAt))) {
    throw new Error('from-now Snapshot Bootstrap requires a valid boundaryCapturedAt')
  }
  return history.boundaryCapturedAt
}

/**
 * Process one bounded page from current CanonicalObservation state.
 *
 * The baseline journal high-water is persisted before the first root scan.
 * Cursor only advances after every graph in the page has reached Durable
 * Pending. A crash after enqueue but before progress update safely replays the
 * same root page because PendingCandidateSink is content-hash deduplicated.
 */
export async function pumpObservationSnapshotBootstrapPage(input: {
  changes: Pick<CanonicalChangeSource, 'highWaterRevision'>
  snapshot: CanonicalObservationSnapshotSource
  dependencies: CanonicalReplicationReader
  sink: PendingCandidateSink
  progress: ObservationSnapshotBootstrapProgressStore
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  limit?: number
  now?: string
}): Promise<ObservationSnapshotBootstrapPageResult> {
  const key = {
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: 'CanonicalObservation' as const,
  }
  let state = await input.progress.get(key)
  let initialized = false

  if (!state) {
    const baselineRevision = await captureReplicationHighWater(input.changes)
    state = {
      ...key,
      baselineRevision,
      snapshotComplete: false,
      updatedAt: input.now ?? new Date().toISOString(),
    }
    // Crash safety: baseline must exist before any Canonical root is scanned.
    await input.progress.put(state)
    initialized = true
  }

  if (state.snapshotComplete) {
    return {
      initialized,
      baselineRevision: state.baselineRevision,
      ...(state.cursor === undefined ? {} : { nextCursor: state.cursor }),
      done: true,
      observationCount: 0,
      blockedCount: 0,
      pending: { total: 0, created: 0, replaced: 0, unchanged: 0 },
    }
  }

  const boundary = fromNowBoundary(input.history)
  const page = await input.snapshot.scan({
    ...(state.cursor === undefined ? {} : { afterId: state.cursor }),
    ...(boundary === undefined ? {} : { capturedAtOnOrAfter: boundary }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })

  let observationCount = 0
  let blockedCount = 0
  let pendingTotal = 0
  let created = 0
  let replaced = 0
  let unchanged = 0

  for (const observation of page.items) {
    observationCount += 1
    const graph = await generateObservationReplicaGraph({
      nodeId: input.nodeId,
      reader: input.dependencies,
      observation,
      phase: 'bootstrap',
      policy: input.policy,
      history: input.history,
    })
    if (graph.kind === 'blocked') {
      blockedCount += 1
      continue
    }

    const pending = await enqueueWireGraph({
      sink: input.sink,
      streamId: input.streamId,
      generationId: input.generationId,
      phase: 'bootstrap',
      policyRevision: input.policy.revision,
      historyRevision: input.history.revision,
      entities: graph.entities,
    })
    pendingTotal += pending.total
    created += pending.created
    replaced += pending.replaced
    unchanged += pending.unchanged
  }

  const nextCursor = page.nextCursor ?? state.cursor
  const nextState: ObservationSnapshotBootstrapProgress = {
    ...state,
    ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    snapshotComplete: page.done,
    updatedAt: input.now ?? new Date().toISOString(),
  }
  await input.progress.put(nextState)

  return {
    initialized,
    baselineRevision: state.baselineRevision,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    done: page.done,
    observationCount,
    blockedCount,
    pending: {
      total: pendingTotal,
      created,
      replaced,
      unchanged,
    },
  }
}
