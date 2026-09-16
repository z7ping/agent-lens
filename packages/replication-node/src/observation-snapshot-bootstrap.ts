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
  enqueueWireGraph,
  type PendingCandidateSink,
} from './pending-sink'
import {
  pumpObservationChanges,
  type CanonicalChangeSource,
  type CanonicalObservationReader,
  type ObservationChangePumpResult,
} from './observation-change-pump'

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
  policyRevision: string
  historyRevision: string
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
  changes: { highWaterRevision(): Promise<number> }
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
  const boundary = fromNowBoundary(input.history)
  let state = await input.progress.get(key)
  let initialized = false

  if (!state) {
    const baselineRevision = await input.changes.highWaterRevision()
    state = {
      ...key,
      baselineRevision,
      policyRevision: input.policy.revision,
      historyRevision: input.history.revision,
      snapshotComplete: false,
      updatedAt: input.now ?? new Date().toISOString(),
    }
    // Crash safety: baseline must exist before any Canonical root is scanned.
    await input.progress.put(state)
    initialized = true
  }

  if (
    state.policyRevision !== input.policy.revision
    || state.historyRevision !== input.history.revision
  ) {
    throw new Error('Snapshot Bootstrap policy/history revision changed; re-bootstrap is required')
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


export interface ObservationSnapshotDeltaProgress {
  streamId: string
  generationId: string
  phase: 'bootstrap'
  entityType: 'CanonicalObservation'
  revision: number
  throughRevision: number
  updatedAt: string
}

export interface ObservationSnapshotDeltaProgressStore {
  get(input: {
    streamId: string
    generationId: string
    phase: 'bootstrap'
    entityType: 'CanonicalObservation'
  }): Promise<ObservationSnapshotDeltaProgress | null>
  put(progress: ObservationSnapshotDeltaProgress): Promise<void>
}

export interface ObservationSnapshotDeltaPageResult extends ObservationChangePumpResult {
  initialized: boolean
  baselineRevision: number
}

/**
 * Catch up CanonicalObservation changes that committed after the Snapshot
 * baseline was fixed. The first call captures one post-snapshot high-water;
 * retries reuse it. After this bounded delta is drained, orchestration can run
 * Reconciliation before activating the stream.
 */
export async function pumpObservationSnapshotDeltaPage(input: {
  changes: CanonicalChangeSource
  observations: CanonicalObservationReader
  dependencies: CanonicalReplicationReader
  sink: PendingCandidateSink
  snapshotProgress: ObservationSnapshotBootstrapProgressStore
  deltaProgress: ObservationSnapshotDeltaProgressStore
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  limit?: number
  now?: string
}): Promise<ObservationSnapshotDeltaPageResult> {
  const snapshotKey = {
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: 'CanonicalObservation' as const,
  }
  const snapshotState = await input.snapshotProgress.get(snapshotKey)
  if (!snapshotState?.snapshotComplete) {
    throw new Error('Snapshot Bootstrap must complete before bootstrap delta catch-up')
  }
  if (
    snapshotState.policyRevision !== input.policy.revision
    || snapshotState.historyRevision !== input.history.revision
  ) {
    throw new Error('Snapshot Bootstrap policy/history revision changed; re-bootstrap is required')
  }

  const key = {
    streamId: input.streamId,
    generationId: input.generationId,
    phase: 'bootstrap' as const,
    entityType: 'CanonicalObservation' as const,
  }
  let state = await input.deltaProgress.get(key)
  let initialized = false

  if (!state) {
    const throughRevision = await input.changes.highWaterRevision()
    if (throughRevision < snapshotState.baselineRevision) {
      throw new Error('Replication change high-water moved behind Snapshot baseline')
    }
    state = {
      ...key,
      revision: snapshotState.baselineRevision,
      throughRevision,
      updatedAt: input.now ?? new Date().toISOString(),
    }
    // Fix catch-up boundary before processing any post-baseline change.
    await input.deltaProgress.put(state)
    initialized = true
  } else if (
    state.revision < snapshotState.baselineRevision
    || state.throughRevision < snapshotState.baselineRevision
  ) {
    throw new Error('Bootstrap delta progress precedes Snapshot baseline')
  }

  const result = await pumpObservationChanges({
    changes: input.changes,
    observations: input.observations,
    dependencies: input.dependencies,
    sink: input.sink,
    nodeId: input.nodeId,
    streamId: input.streamId,
    generationId: input.generationId,
    phase: 'bootstrap',
    policy: input.policy,
    history: input.history,
    throughRevision: state.throughRevision,
    afterRevision: state.revision,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })

  const nextRevision = result.done ? state.throughRevision : result.nextRevision
  await input.deltaProgress.put({
    ...state,
    revision: nextRevision,
    updatedAt: input.now ?? new Date().toISOString(),
  })

  return {
    ...result,
    nextRevision,
    initialized,
    baselineRevision: snapshotState.baselineRevision,
  }
}
