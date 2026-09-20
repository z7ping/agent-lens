import type { Plugin } from '@deepseek-ai/cordis'
import type {
  CanonicalObservation,
  ObservationCursor,
  ProjectionDefinition,
  ProjectionScope,
  StorageService,
  TaskFileChangeProjectionStore,
} from '@agent-lens/core'
import type { AgentLensContext } from '@agent-lens/runtime-cordis'
import {
  captureGitWorkspaceSnapshot,
  compareGitWorkspaceSnapshot,
  type GitWorkspaceSnapshot,
} from './git-workspace-snapshot'
import {
  observedTaskFileChanges,
  reconcileTaskFileChanges,
  summarizeObservedTaskFileChanges,
  toolMutationIntent,
  toolResultCallId,
} from './task-file-changes'

export const TASK_FILE_CHANGE_PROJECTION_ID = 'task-file-changes'
const OBSERVATION_PAGE_SIZE = 1000

function effectiveAt(observation: CanonicalObservation): string {
  return observation.occurredAt ?? observation.capturedAt
}

function observationCursor(observation: CanonicalObservation): ObservationCursor {
  const sequence = observation.canonicalSequence ?? observation.sourceSequence
  return {
    effectiveAt: effectiveAt(observation),
    ...(sequence === undefined ? {} : { sequence }),
    id: observation.id,
  }
}

async function loadSessionObservations(
  storage: StorageService,
  logicalSessionId: string,
  signal?: AbortSignal,
): Promise<CanonicalObservation[]> {
  const result: CanonicalObservation[] = []
  let after: ObservationCursor | undefined
  while (!signal?.aborted) {
    const page = await storage.repositories.observations.query({
      logicalSessionIds: [logicalSessionId],
      ...(after ? { after } : {}),
      order: 'asc',
      limit: OBSERVATION_PAGE_SIZE,
    })
    if (!page.length) break
    result.push(...page)
    if (page.length < OBSERVATION_PAGE_SIZE) break
    after = observationCursor(page[page.length - 1]!)
  }
  return result
}

async function discoverToolSessionIds(
  storage: StorageService,
  signal?: AbortSignal,
): Promise<string[]> {
  const ids = new Set<string>()
  let after: ObservationCursor | undefined
  while (!signal?.aborted) {
    const page = await storage.repositories.observations.query({
      ...(after ? { after } : {}),
      order: 'asc',
      limit: OBSERVATION_PAGE_SIZE,
    })
    if (!page.length) break
    for (const observation of page) {
      if (observation.kind === 'tool.call' || observation.kind === 'tool.result') {
        ids.add(observation.logicalSessionId)
      }
    }
    if (page.length < OBSERVATION_PAGE_SIZE) break
    after = observationCursor(page[page.length - 1]!)
  }
  return [...ids]
}

function scopeSessionId(scope?: ProjectionScope): string | undefined {
  return scope?.subjectType === 'logical-session' ? scope.subjectId : undefined
}

function gitBaseline(capture: Awaited<ReturnType<TaskFileChangeProjectionStore['getByRuntime']>>): GitWorkspaceSnapshot | null {
  if (!capture?.gitRootPath || !capture.baselineTreeSha) return null
  return {
    rootPath: capture.gitRootPath,
    treeSha: capture.baselineTreeSha,
    capturedAt: capture.baselineCapturedAt,
  }
}

const applyTaskFileChangeProjection: Plugin.Function<void> = (ctx: AgentLensContext) => {
  const store = ctx.storage.taskFileChanges
  if (!store) return

  let disposed = false
  let parserReplayDepth = 0
  const replaySessions = new Set<string>()
  const pendingCalls = new Map<string, Map<string, CanonicalObservation>>()
  const eventQueues = new Map<string, Promise<void>>()
  const settledQueues = new Map<string, Promise<void>>()

  const publish = (logicalSessionId: string) => {
    ctx.emit('projection/rebuilt', {
      projectionId: TASK_FILE_CHANGE_PROJECTION_ID,
      subjectType: 'logical-session',
      subjectId: logicalSessionId,
    })
  }

  const replaceObserved = async (
    logicalSessionId: string,
    observations?: CanonicalObservation[],
    signal?: AbortSignal,
  ) => {
    const source = observations ?? await loadSessionObservations(ctx.storage, logicalSessionId, signal)
    if (signal?.aborted) return
    const changes = summarizeObservedTaskFileChanges(observedTaskFileChanges(source))
    if (await store.replaceObservedSession(logicalSessionId, changes)) publish(logicalSessionId)
  }

  const mergeObserved = async (
    logicalSessionId: string,
    observations: readonly CanonicalObservation[],
  ) => {
    const changes = summarizeObservedTaskFileChanges(observedTaskFileChanges(observations))
    if (!changes.length) return
    if (await store.mergeObservedSession(logicalSessionId, changes)) publish(logicalSessionId)
  }

  const handleCommittedObservation = async (
    event: { observationId: string; logicalSessionId: string; kind: CanonicalObservation['kind'] },
  ) => {
    if (disposed || (event.kind !== 'tool.call' && event.kind !== 'tool.result')) return
    if (parserReplayDepth > 0) {
      replaySessions.add(event.logicalSessionId)
      return
    }

    const observation = await ctx.storage.repositories.observations.get(event.observationId)
    if (!observation) return

    if (observation.kind === 'tool.call') {
      const intent = toolMutationIntent(observation)
      if (!intent) return
      if (intent.callId) {
        let calls = pendingCalls.get(observation.logicalSessionId)
        if (!calls) {
          calls = new Map()
          pendingCalls.set(observation.logicalSessionId, calls)
        }
        calls.set(intent.callId, observation)
        return
      }
      await mergeObserved(observation.logicalSessionId, [observation])
      return
    }

    const id = toolResultCallId(observation)
    const calls = pendingCalls.get(observation.logicalSessionId)
    const call = id ? calls?.get(id) : undefined
    if (id) calls?.delete(id)
    if (calls?.size === 0) pendingCalls.delete(observation.logicalSessionId)

    if (call) {
      await mergeObserved(observation.logicalSessionId, [call, observation])
      return
    }

    // A result may arrive after Daemon recovery without its in-memory call.
    // Rebuild only this logical session in that exceptional path.
    await replaceObserved(observation.logicalSessionId)
  }

  const enqueueObservation = (
    event: { observationId: string; logicalSessionId: string; kind: CanonicalObservation['kind'] },
  ) => {
    const previous = eventQueues.get(event.logicalSessionId) ?? Promise.resolve()
    let next!: Promise<void>
    next = previous
      .catch(() => undefined)
      .then(() => handleCommittedObservation(event))
      .catch(error => {
        if (!disposed) console.warn('[AgentLens] task file change observation refresh failed', error)
      })
      .finally(() => {
        if (eventQueues.get(event.logicalSessionId) === next) eventQueues.delete(event.logicalSessionId)
      })
    eventQueues.set(event.logicalSessionId, next)
  }

  const ensureBaseline = async (runtime: Parameters<NonNullable<Parameters<typeof ctx.lives.observe>[0]['beforeSend']>>[0]['runtime']) => {
    const existing = await store.getByRuntime(runtime.runtimeSessionId)
    if (existing) {
      if (runtime.logicalSessionId && !existing.logicalSessionId) {
        await store.bindRuntime(runtime.runtimeSessionId, runtime.logicalSessionId)
      }
      return
    }
    if (!runtime.workspacePath) return

    let baseline: GitWorkspaceSnapshot | null = null
    try {
      baseline = await captureGitWorkspaceSnapshot(runtime.workspacePath)
    } catch (error) {
      console.warn('[AgentLens] task file Git baseline capture failed; using observed mode', error)
    }
    const capturedAt = baseline?.capturedAt ?? new Date().toISOString()
    await store.putBaseline({
      runtimeSessionId: runtime.runtimeSessionId,
      ...(runtime.logicalSessionId ? { logicalSessionId: runtime.logicalSessionId } : {}),
      workspacePath: runtime.workspacePath,
      ...(baseline ? {
        gitRootPath: baseline.rootPath,
        baselineTreeSha: baseline.treeSha,
      } : {}),
      baselineCapturedAt: capturedAt,
    })
  }

  const settle = async (
    context: Parameters<NonNullable<Parameters<typeof ctx.lives.observe>[0]['settled']>>[0],
  ) => {
    const logicalSessionId = context.runtime.logicalSessionId
    const capture = await store.getByRuntime(context.runtime.runtimeSessionId)

    if (!logicalSessionId) {
      if (capture?.logicalSessionId) {
        await replaceObserved(capture.logicalSessionId)
      }
      return
    }

    if (capture && !capture.logicalSessionId) {
      await store.bindRuntime(context.runtime.runtimeSessionId, logicalSessionId)
    }

    const observations = await loadSessionObservations(ctx.storage, logicalSessionId)
    const observed = observedTaskFileChanges(observations)
    const baseline = gitBaseline(capture)
    let git = null
    if (baseline) {
      try {
        git = await compareGitWorkspaceSnapshot(baseline)
      } catch (error) {
        console.warn('[AgentLens] task file Git reconciliation failed; using observed mode', error)
      }
    }

    if (!git || !capture) {
      const changes = summarizeObservedTaskFileChanges(observed)
      if (await store.replaceObservedSession(logicalSessionId, changes)) publish(logicalSessionId)
      return
    }

    const settledAt = new Date().toISOString()
    const changes = reconcileTaskFileChanges(
      logicalSessionId,
      observed,
      git.changes,
      {
        startedAt: capture.baselineCapturedAt,
        endedAt: settledAt,
      },
    )

    if (context.reason === 'terminated' || context.reason === 'failed') {
      await store.finalizeRuntime(context.runtime.runtimeSessionId, {
        logicalSessionId,
        finalTreeSha: git.current.treeSha,
        finalizedAt: settledAt,
        changes,
      })
    } else {
      await store.checkpointRuntime(context.runtime.runtimeSessionId, {
        logicalSessionId,
        finalTreeSha: git.current.treeSha,
        checkpointedAt: settledAt,
        changes,
      })
    }
    publish(logicalSessionId)
  }

  const enqueueSettled = (
    context: Parameters<NonNullable<Parameters<typeof ctx.lives.observe>[0]['settled']>>[0],
  ) => {
    const id = context.runtime.runtimeSessionId
    const previous = settledQueues.get(id) ?? Promise.resolve()
    let next!: Promise<void>
    next = previous
      .catch(() => undefined)
      .then(() => settle(context))
      .catch(error => {
        if (!disposed) console.warn('[AgentLens] task file change reconciliation failed', error)
      })
      .finally(() => {
        if (settledQueues.get(id) === next) settledQueues.delete(id)
      })
    settledQueues.set(id, next)
  }

  const observerRegistration = ctx.lives.observe({
    beforeSend: context => ensureBaseline(context.runtime),
    settled: context => enqueueSettled(context),
  })

  ctx.on('observation/committed', event => {
    if (event.kind !== 'tool.call' && event.kind !== 'tool.result') return
    enqueueObservation(event)
  })

  ctx.on('source/parser-replay-state', event => {
    if (event.state === 'started') {
      parserReplayDepth += 1
      return
    }
    parserReplayDepth = Math.max(0, parserReplayDepth - 1)
    if (parserReplayDepth > 0 || replaySessions.size === 0) return
    const ids = [...replaySessions]
    replaySessions.clear()
    void (async () => {
      for (const logicalSessionId of ids) await replaceObserved(logicalSessionId)
    })().catch(error => {
      if (!disposed) console.warn('[AgentLens] task file change replay refresh failed', error)
    })
  })

  const definition: ProjectionDefinition = {
    id: TASK_FILE_CHANGE_PROJECTION_ID,
    async rebuild(scope) {
      const logicalSessionId = scopeSessionId(scope)
      const signal = scope?.signal
      if (logicalSessionId) {
        await store.rebuild({ logicalSessionId, ...(signal ? { signal } : {}) })
        if (!signal?.aborted) await replaceObserved(logicalSessionId, undefined, signal)
        return
      }

      await store.rebuild(signal ? { signal } : {})
      if (signal?.aborted) return
      const ids = await discoverToolSessionIds(ctx.storage, signal)
      for (const id of ids) {
        if (signal?.aborted) return
        await replaceObserved(id, undefined, signal)
      }
    },
    async flush() {
      await Promise.all([...eventQueues.values()])
      await Promise.all([...settledQueues.values()])
    },
  }
  const projectionRegistration = ctx.projections.register(definition)

  return async () => {
    disposed = true
    await definition.flush?.()
    observerRegistration.dispose()
    pendingCalls.clear()
    replaySessions.clear()
    await projectionRegistration.dispose()
  }
}

applyTaskFileChangeProjection.inject = ['storage', 'projections', 'lives']

export const taskFileChangeProjectionPlugin = applyTaskFileChangeProjection
