import {
  reconcileReplicationPage,
  type HistoryBoundary,
  type IndependentReplicationRootEntityType,
  type IndependentReplicationRootSnapshotSource,
  type KnownReplicationEntityType,
  type ReplicationPolicy,
  type ReplicationReconciliationSink,
} from '@agent-lens/core/replication'
import type { CanonicalReplicationReader } from './canonical-dependency-graph'
import {
  generateIndependentRootReplicaGraph,
} from './independent-root-graph'
import type {
  CanonicalChangeSource,
} from './observation-change-pump'
import type {
  ObservationCaptureProgressStore,
} from './observation-snapshot-bootstrap'
import {
  enqueueWireGraph,
  type PendingCandidateSink,
} from './pending-sink'
import {
  pendingCandidatesForWireGraph,
  type PendingWireCandidate,
} from './pending-candidate'
import type {
  ObservationPeriodicReconciliationCycleStore,
  ObservationPeriodicReconciliationResult,
} from './observation-periodic-reconciliation'

type BootstrapStage = 'staged' | 'snapshot' | 'delta' | 'reconcile' | 'active'

interface SnapshotProgress {
  streamId: string
  generationId: string
  entityType: KnownReplicationEntityType
  baselineRevision: number
  policyRevision: string
  historyRevision: string
  cursor?: string
  snapshotComplete: boolean
  updatedAt: string
}

interface ChangeProgress {
  streamId: string
  generationId: string
  phase: 'bootstrap' | 'incremental' | 'reconcile'
  entityType: KnownReplicationEntityType
  revision: number
  throughRevision: number
  updatedAt: string
}

interface LifecycleState {
  streamId: string
  generationId: string
  entityType: KnownReplicationEntityType
  stage: BootstrapStage
  policyRevision: string
  historyRevision: string
  updatedAt: string
}

export interface IndependentRootSnapshotProgressStore {
  get<TEntityType extends KnownReplicationEntityType>(input: {
    streamId: string
    generationId: string
    entityType: TEntityType
  }): Promise<(SnapshotProgress & { entityType: TEntityType }) | null>
  put(progress: SnapshotProgress): Promise<void>
}

export interface IndependentRootChangeProgressStore {
  get<
    TPhase extends ChangeProgress['phase'],
    TEntityType extends KnownReplicationEntityType,
  >(input: {
    streamId: string
    generationId: string
    phase: TPhase
    entityType: TEntityType
  }): Promise<(ChangeProgress & { phase: TPhase; entityType: TEntityType }) | null>
  put(progress: ChangeProgress): Promise<void>
}

export interface IndependentRootBootstrapLifecycleStore {
  ensure(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
    policyRevision: string
    historyRevision: string
    now?: string
  }): Promise<LifecycleState>
  transition(input: {
    streamId: string
    generationId: string
    entityType: KnownReplicationEntityType
    stage: BootstrapStage
    policyRevision: string
    historyRevision: string
    now?: string
  }): Promise<LifecycleState>
}

export interface IndependentRootChangePumpResult {
  throughRevision: number
  nextRevision: number
  done: boolean
  changeCount: number
  rootCount: number
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
  if (
    !history.boundaryCapturedAt
    || !Number.isFinite(Date.parse(history.boundaryCapturedAt))
  ) {
    throw new Error('from-now Independent Root processing requires a valid boundaryCapturedAt')
  }
  return history.boundaryCapturedAt
}

async function pumpIndependentRootChanges(input: {
  entityType: IndependentReplicationRootEntityType
  changes: CanonicalChangeSource
  roots: IndependentReplicationRootSnapshotSource
  dependencies: CanonicalReplicationReader
  sink: PendingCandidateSink
  nodeId: string
  streamId: string
  generationId: string
  phase: 'bootstrap' | 'incremental' | 'reconcile'
  policy: ReplicationPolicy
  history: HistoryBoundary
  throughRevision: number
  afterRevision?: number
  limit?: number
}): Promise<IndependentRootChangePumpResult> {
  const page = await input.changes.scan({
    ...(input.afterRevision === undefined
      ? {}
      : { afterRevision: input.afterRevision }),
    throughRevision: input.throughRevision,
    entityType: input.entityType,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })

  const seen = new Set<string>()
  let rootCount = 0
  let blockedCount = 0
  let total = 0
  let created = 0
  let replaced = 0
  let unchanged = 0

  for (const change of page.items) {
    if (seen.has(change.originEntityId)) continue
    seen.add(change.originEntityId)

    const root = await input.roots.get(input.entityType, change.originEntityId)
    if (!root) {
      throw new Error(
        `Replication Canonical row missing without tombstone: ${input.entityType}:${change.originEntityId}`,
      )
    }
    rootCount += 1
    const graph = await generateIndependentRootReplicaGraph({
      nodeId: input.nodeId,
      dependencies: input.dependencies,
      roots: input.roots,
      root,
      phase: input.phase,
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
      phase: input.phase,
      policyRevision: input.policy.revision,
      historyRevision: input.history.revision,
      entities: graph.entities,
    })
    total += pending.total
    created += pending.created
    replaced += pending.replaced
    unchanged += pending.unchanged
  }

  return {
    throughRevision: input.throughRevision,
    nextRevision: page.nextRevision,
    done: page.done,
    changeCount: page.items.length,
    rootCount,
    blockedCount,
    pending: { total, created, replaced, unchanged },
  }
}

async function pumpSnapshotPage(input: {
  entityType: IndependentReplicationRootEntityType
  changes: CanonicalChangeSource
  roots: IndependentReplicationRootSnapshotSource
  dependencies: CanonicalReplicationReader
  sink: PendingCandidateSink
  progress: IndependentRootSnapshotProgressStore
  captureProgress: ObservationCaptureProgressStore
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  limit?: number
  now?: string
}): Promise<{ done: boolean; scanned: number; baselineRevision: number }> {
  const key = {
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: input.entityType,
  }
  let state = await input.progress.get(key)
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
    await input.progress.put(state)
  }
  if (
    state.policyRevision !== input.policy.revision
    || state.historyRevision !== input.history.revision
  ) {
    throw new Error('Independent Root Snapshot policy/history revision changed; re-bootstrap is required')
  }

  await input.captureProgress.advance({
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: input.entityType,
    capturedRevision: state.baselineRevision,
    ...(input.now === undefined ? {} : { now: input.now }),
  })

  if (state.snapshotComplete) {
    return { done: true, scanned: 0, baselineRevision: state.baselineRevision }
  }

  const boundary = fromNowBoundary(input.history)
  const page = await input.roots.scan({
    entityType: input.entityType,
    ...(state.cursor === undefined ? {} : { afterId: state.cursor }),
    ...(boundary === undefined ? {} : { changedAtOnOrAfter: boundary }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })

  for (const root of page.items) {
    const graph = await generateIndependentRootReplicaGraph({
      nodeId: input.nodeId,
      dependencies: input.dependencies,
      roots: input.roots,
      root,
      phase: 'bootstrap',
      policy: input.policy,
      history: input.history,
    })
    if (graph.kind === 'blocked') continue
    await enqueueWireGraph({
      sink: input.sink,
      streamId: input.streamId,
      generationId: input.generationId,
      phase: 'bootstrap',
      policyRevision: input.policy.revision,
      historyRevision: input.history.revision,
      entities: graph.entities,
    })
  }

  const nextCursor = page.nextCursor ?? state.cursor
  await input.progress.put({
    ...state,
    ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    snapshotComplete: page.done,
    updatedAt: input.now ?? new Date().toISOString(),
  })
  return {
    done: page.done,
    scanned: page.items.length,
    baselineRevision: state.baselineRevision,
  }
}

async function pumpBootstrapDeltaPage(input: {
  entityType: IndependentReplicationRootEntityType
  changes: CanonicalChangeSource
  roots: IndependentReplicationRootSnapshotSource
  dependencies: CanonicalReplicationReader
  sink: PendingCandidateSink
  snapshotProgress: IndependentRootSnapshotProgressStore
  deltaProgress: IndependentRootChangeProgressStore
  captureProgress: ObservationCaptureProgressStore
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  limit?: number
  now?: string
}): Promise<IndependentRootChangePumpResult> {
  const snapshot = await input.snapshotProgress.get({
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: input.entityType,
  })
  if (!snapshot?.snapshotComplete) {
    throw new Error('Independent Root Snapshot must complete before delta catch-up')
  }
  if (
    snapshot.policyRevision !== input.policy.revision
    || snapshot.historyRevision !== input.history.revision
  ) {
    throw new Error('Independent Root Snapshot policy/history revision changed; re-bootstrap is required')
  }

  const key = {
    streamId: input.streamId,
    generationId: input.generationId,
    phase: 'bootstrap' as const,
    entityType: input.entityType,
  }
  let state = await input.deltaProgress.get(key)
  if (!state) {
    const throughRevision = await input.changes.highWaterRevision()
    if (throughRevision < snapshot.baselineRevision) {
      throw new Error('Replication high-water moved behind Independent Root baseline')
    }
    state = {
      ...key,
      revision: snapshot.baselineRevision,
      throughRevision,
      updatedAt: input.now ?? new Date().toISOString(),
    }
    await input.deltaProgress.put(state)
  } else if (
    state.revision < snapshot.baselineRevision
    || state.throughRevision < snapshot.baselineRevision
  ) {
    throw new Error('Independent Root bootstrap delta progress precedes Snapshot baseline')
  }

  const result = await pumpIndependentRootChanges({
    entityType: input.entityType,
    changes: input.changes,
    roots: input.roots,
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
  await input.captureProgress.advance({
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: input.entityType,
    capturedRevision: nextRevision,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return { ...result, nextRevision }
}

function createReconciliationSource(input: {
  entityType: IndependentReplicationRootEntityType
  roots: IndependentReplicationRootSnapshotSource
  dependencies: CanonicalReplicationReader
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
}) {
  const boundary = fromNowBoundary(input.history)
  return {
    async scan(args: {
      entityType: KnownReplicationEntityType
      cursor?: string
      limit: number
    }) {
      if (args.entityType !== input.entityType) {
        throw new Error(
          `Independent Root reconciliation expected ${input.entityType}, got ${args.entityType}`,
        )
      }
      const page = await input.roots.scan({
        entityType: input.entityType,
        ...(args.cursor ? { afterId: args.cursor } : {}),
        ...(boundary === undefined ? {} : { changedAtOnOrAfter: boundary }),
        limit: args.limit,
      })

      const candidates = new Map<string, PendingWireCandidate>()
      for (const root of page.items) {
        const graph = await generateIndependentRootReplicaGraph({
          nodeId: input.nodeId,
          dependencies: input.dependencies,
          roots: input.roots,
          root,
          phase: 'reconcile',
          policy: input.policy,
          history: input.history,
        })
        if (graph.kind === 'blocked') continue
        for (const candidate of pendingCandidatesForWireGraph({
          streamId: input.streamId,
          generationId: input.generationId,
          phase: 'reconcile',
          policyRevision: input.policy.revision,
          historyRevision: input.history.revision,
          entities: graph.entities,
        })) {
          candidates.set(candidate.dedupKey, candidate)
        }
      }

      return {
        items: [...candidates.values()].map(candidate => ({
          id: candidate.id,
          dedupKey: candidate.dedupKey,
          entityType: candidate.entityType,
          originEntityId: candidate.originEntityId,
          candidateHash: candidate.candidateHash,
          payload: candidate.payload,
        })),
        nextCursor: page.nextCursor ?? args.cursor ?? '',
        done: page.done,
      }
    },
  }
}

async function pumpBootstrapStep(input: {
  entityType: IndependentReplicationRootEntityType
  changes: CanonicalChangeSource
  roots: IndependentReplicationRootSnapshotSource
  dependencies: CanonicalReplicationReader
  pendingSink: PendingCandidateSink
  reconciliationSink: ReplicationReconciliationSink
  snapshotProgress: IndependentRootSnapshotProgressStore
  deltaProgress: IndependentRootChangeProgressStore
  captureProgress: ObservationCaptureProgressStore
  lifecycle: IndependentRootBootstrapLifecycleStore
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  limit?: number
  now?: string
}): Promise<{ stage: BootstrapStage; active: boolean }> {
  const key = {
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: input.entityType,
    policyRevision: input.policy.revision,
    historyRevision: input.history.revision,
    ...(input.now === undefined ? {} : { now: input.now }),
  }
  let lifecycle = await input.lifecycle.ensure(key)

  if (lifecycle.stage === 'staged') {
    lifecycle = await input.lifecycle.transition({ ...key, stage: 'snapshot' })
  }
  if (lifecycle.stage === 'snapshot') {
    const result = await pumpSnapshotPage({
      ...input,
      progress: input.snapshotProgress,
      sink: input.pendingSink,
    })
    if (result.done) {
      lifecycle = await input.lifecycle.transition({ ...key, stage: 'delta' })
    }
    return { stage: lifecycle.stage, active: false }
  }
  if (lifecycle.stage === 'delta') {
    const result = await pumpBootstrapDeltaPage({
      ...input,
      sink: input.pendingSink,
    })
    if (result.done) {
      lifecycle = await input.lifecycle.transition({ ...key, stage: 'reconcile' })
    }
    return { stage: lifecycle.stage, active: false }
  }
  if (lifecycle.stage === 'reconcile') {
    const result = await reconcileReplicationPage({
      source: createReconciliationSource(input),
      sink: input.reconciliationSink,
      streamId: input.streamId,
      generationId: input.generationId,
      entityType: input.entityType,
      policyRevision: input.policy.revision,
      historyRevision: input.history.revision,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })
    if (result.done) {
      lifecycle = await input.lifecycle.transition({ ...key, stage: 'active' })
    }
    return { stage: lifecycle.stage, active: lifecycle.stage === 'active' }
  }
  return { stage: 'active', active: true }
}

async function pumpIncrementalPage(input: {
  entityType: IndependentReplicationRootEntityType
  changes: CanonicalChangeSource
  roots: IndependentReplicationRootSnapshotSource
  dependencies: CanonicalReplicationReader
  sink: PendingCandidateSink
  progress: IndependentRootChangeProgressStore
  captureProgress: ObservationCaptureProgressStore
  startRevision: number
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  limit?: number
  now?: string
}): Promise<IndependentRootChangePumpResult> {
  if (!Number.isInteger(input.startRevision) || input.startRevision < 0) {
    throw new TypeError('Independent Root incremental startRevision must be a non-negative integer')
  }
  const now = input.now ?? new Date().toISOString()
  const key = {
    streamId: input.streamId,
    generationId: input.generationId,
    phase: 'incremental' as const,
    entityType: input.entityType,
  }
  let state = await input.progress.get(key)
  if (!state) {
    state = {
      ...key,
      revision: input.startRevision,
      throughRevision: input.startRevision,
      updatedAt: now,
    }
    await input.progress.put(state)
    await input.captureProgress.advance({
      streamId: input.streamId,
      generationId: input.generationId,
      entityType: input.entityType,
      capturedRevision: input.startRevision,
      ...(input.now === undefined ? {} : { now: input.now }),
    })
  }
  if (state.revision < input.startRevision) {
    throw new Error('Independent Root incremental progress precedes Bootstrap watermark')
  }

  if (state.revision === state.throughRevision) {
    const highWater = await input.changes.highWaterRevision()
    if (highWater < state.revision) {
      throw new Error('Replication high-water moved behind Independent Root incremental progress')
    }
    if (highWater === state.revision) {
      return {
        throughRevision: state.throughRevision,
        nextRevision: state.revision,
        done: true,
        changeCount: 0,
        rootCount: 0,
        blockedCount: 0,
        pending: { total: 0, created: 0, replaced: 0, unchanged: 0 },
      }
    }
    if (highWater > state.throughRevision) {
      state = { ...state, throughRevision: highWater, updatedAt: now }
      await input.progress.put(state)
    }
  }

  const result = await pumpIndependentRootChanges({
    entityType: input.entityType,
    changes: input.changes,
    roots: input.roots,
    dependencies: input.dependencies,
    sink: input.sink,
    nodeId: input.nodeId,
    streamId: input.streamId,
    generationId: input.generationId,
    phase: 'incremental',
    policy: input.policy,
    history: input.history,
    throughRevision: state.throughRevision,
    afterRevision: state.revision,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })
  const nextRevision = result.done ? state.throughRevision : result.nextRevision
  await input.progress.put({ ...state, revision: nextRevision, updatedAt: now })
  await input.captureProgress.advance({
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: input.entityType,
    capturedRevision: nextRevision,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return { ...result, nextRevision }
}

async function pumpPeriodicReconciliationPage(input: {
  entityType: IndependentReplicationRootEntityType
  changes: CanonicalChangeSource
  roots: IndependentReplicationRootSnapshotSource
  dependencies: CanonicalReplicationReader
  sink: ReplicationReconciliationSink
  cycles: ObservationPeriodicReconciliationCycleStore
  captureProgress: ObservationCaptureProgressStore
  incrementalProgress: IndependentRootChangeProgressStore
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  intervalMs: number
  limit?: number
  now?: string
}): Promise<ObservationPeriodicReconciliationResult> {
  const now = input.now ?? new Date().toISOString()
  const highWater = await input.changes.highWaterRevision()
  const cycleResult = await input.cycles.beginReconciliationCycle({
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: input.entityType,
    throughRevision: highWater,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  if (cycleResult.kind === 'not-due') return cycleResult
  const cycle = cycleResult.cycle

  const result = await reconcileReplicationPage({
    source: createReconciliationSource(input),
    sink: input.sink,
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: input.entityType,
    policyRevision: input.policy.revision,
    historyRevision: input.history.revision,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })
  if (!result.done) {
    return {
      kind: 'running',
      cycle: cycle.cycle,
      throughRevision: cycle.throughRevision,
      scanned: result.scanned,
      done: false,
    }
  }

  const progress = await input.incrementalProgress.get({
    streamId: input.streamId,
    generationId: input.generationId,
    phase: 'incremental',
    entityType: input.entityType,
  })
  if (!progress) {
    throw new Error('Independent Root periodic Reconciliation requires incremental progress')
  }
  await input.incrementalProgress.put({
    ...progress,
    revision: Math.max(progress.revision, cycle.throughRevision),
    throughRevision: Math.max(progress.throughRevision, cycle.throughRevision),
    updatedAt: now,
  })
  await input.captureProgress.advance({
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: input.entityType,
    capturedRevision: cycle.throughRevision,
    ...(input.now === undefined ? {} : { now: input.now }),
  })

  const nowTimestamp = Date.parse(now)
  if (!Number.isFinite(nowTimestamp)) {
    throw new Error('Independent Root periodic Reconciliation now must be a valid timestamp')
  }
  if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
    throw new TypeError('Independent Root periodic Reconciliation intervalMs must be positive')
  }
  const dueAt = new Date(nowTimestamp + input.intervalMs).toISOString()
  await input.cycles.completeReconciliationCycle({
    streamId: input.streamId,
    generationId: input.generationId,
    entityType: input.entityType,
    nextDueAt: dueAt,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  return {
    kind: 'completed',
    cycle: cycle.cycle,
    throughRevision: cycle.throughRevision,
    scanned: result.scanned,
    nextDueAt: dueAt,
  }
}

export type IndependentRootRuntimeStepResult =
  | { kind: 'bootstrap'; stage: BootstrapStage }
  | {
      kind: 'incremental'
      throughRevision: number
      nextRevision: number
    }
  | {
      kind: 'active'
      incrementalThroughRevision: number
      reconciliation: ObservationPeriodicReconciliationResult
    }

export async function pumpIndependentRootRuntimeStep(input: {
  entityType: IndependentReplicationRootEntityType
  changes: CanonicalChangeSource
  roots: IndependentReplicationRootSnapshotSource
  dependencies: CanonicalReplicationReader
  pendingSink: PendingCandidateSink
  reconciliationSink: ReplicationReconciliationSink
  snapshotProgress: IndependentRootSnapshotProgressStore
  deltaProgress: IndependentRootChangeProgressStore
  incrementalProgress: IndependentRootChangeProgressStore
  captureProgress: ObservationCaptureProgressStore
  lifecycle: IndependentRootBootstrapLifecycleStore
  cycles: ObservationPeriodicReconciliationCycleStore
  nodeId: string
  streamId: string
  generationId: string
  policy: ReplicationPolicy
  history: HistoryBoundary
  pageLimit?: number
  reconciliationIntervalMs: number
  now?: string
}): Promise<IndependentRootRuntimeStepResult> {
  const bootstrap = await pumpBootstrapStep({
    ...input,
    ...(input.pageLimit === undefined ? {} : { limit: input.pageLimit }),
  })
  if (!bootstrap.active) {
    return { kind: 'bootstrap', stage: bootstrap.stage }
  }

  const bootstrapDelta = await input.deltaProgress.get({
    streamId: input.streamId,
    generationId: input.generationId,
    phase: 'bootstrap',
    entityType: input.entityType,
  })
  if (!bootstrapDelta || bootstrapDelta.revision < bootstrapDelta.throughRevision) {
    throw new Error('Active Independent Root lifecycle requires completed delta progress')
  }

  const incremental = await pumpIncrementalPage({
    entityType: input.entityType,
    changes: input.changes,
    roots: input.roots,
    dependencies: input.dependencies,
    sink: input.pendingSink,
    progress: input.incrementalProgress,
    captureProgress: input.captureProgress,
    startRevision: bootstrapDelta.throughRevision,
    nodeId: input.nodeId,
    streamId: input.streamId,
    generationId: input.generationId,
    policy: input.policy,
    history: input.history,
    ...(input.pageLimit === undefined ? {} : { limit: input.pageLimit }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  if (!incremental.done) {
    return {
      kind: 'incremental',
      throughRevision: incremental.throughRevision,
      nextRevision: incremental.nextRevision,
    }
  }

  const reconciliation = await pumpPeriodicReconciliationPage({
    entityType: input.entityType,
    changes: input.changes,
    roots: input.roots,
    dependencies: input.dependencies,
    sink: input.reconciliationSink,
    cycles: input.cycles,
    captureProgress: input.captureProgress,
    incrementalProgress: input.incrementalProgress,
    nodeId: input.nodeId,
    streamId: input.streamId,
    generationId: input.generationId,
    policy: input.policy,
    history: input.history,
    intervalMs: input.reconciliationIntervalMs,
    ...(input.pageLimit === undefined ? {} : { limit: input.pageLimit }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })

  return {
    kind: 'active',
    incrementalThroughRevision: incremental.throughRevision,
    reconciliation,
  }
}
