import { randomUUID } from 'node:crypto'
import type {
  LiveAvailability,
  LiveRuntimeState,
  LiveSnapshot,
} from '@agent-lens/core'
import { LiveEventChannel } from '@agent-lens/live-support'
import { HermesApiClient } from './client.js'

export interface HermesLiveStartInput {
  title?: string
}

interface OwnedRuntime {
  id: string
  nativeSessionId?: string
  status: LiveRuntimeState['status']
  events: LiveEventChannel
  activeRunId?: string
  streamAbort?: AbortController
  streamTask?: Promise<void>
}

const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1_000)
}

function parseStartInput(value: unknown): HermesLiveStartInput {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Hermes Live start input must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.title !== undefined && typeof record.title !== 'string') {
    throw new TypeError('Hermes Live start input title must be a string')
  }
  return typeof record.title === 'string' && record.title.trim()
    ? { title: record.title.trim() }
    : {}
}

export class DefaultHermesLiveService {
  private readonly runtimes = new Map<string, OwnedRuntime>()
  private disposed = false

  constructor(readonly client: HermesApiClient) {}

  async availability(): Promise<LiveAvailability> {
    if (!this.client.configured) {
      return {
        available: false,
        reason: 'Hermes API_SERVER_KEY is not configured for AgentLens',
      }
    }
    try {
      await this.client.capabilities()
      return { available: true }
    } catch (error) {
      return {
        available: false,
        reason: safeError(error),
      }
    }
  }

  async list(): Promise<LiveRuntimeState[]> {
    return [...this.runtimes.values()].map(runtime => this.runtimeState(runtime))
  }

  async start(input: unknown): Promise<LiveRuntimeState> {
    if (this.disposed) throw new Error('Hermes Live service is disposed')
    const parsed = parseStartInput(input)
    const runtime: OwnedRuntime = {
      id: randomUUID(),
      status: 'initializing',
      events: new LiveEventChannel('pending'),
    }
    runtime.events = new LiveEventChannel(runtime.id)
    this.runtimes.set(runtime.id, runtime)

    try {
      runtime.nativeSessionId = await this.client.createSession(parsed)
      runtime.status = 'ready'
      runtime.events.publish({
        type: 'runtime_status',
        status: 'ready',
        nativeSessionId: runtime.nativeSessionId,
      })
    } catch (error) {
      runtime.status = 'failed'
      runtime.events.publish({
        type: 'runtime_status',
        status: 'failed',
        error: safeError(error),
      })
      throw error
    }

    return this.runtimeState(runtime)
  }

  async state(runtimeSessionId: string): Promise<LiveRuntimeState> {
    const runtime = this.runtime(runtimeSessionId)
    await this.refreshActiveRun(runtime)
    return this.runtimeState(runtime)
  }

  async snapshot(runtimeSessionId: string): Promise<LiveSnapshot> {
    const runtime = this.runtime(runtimeSessionId)
    await this.refreshActiveRun(runtime)
    const entries = runtime.nativeSessionId
      ? await this.client.sessionMessages(runtime.nativeSessionId)
      : []
    return {
      state: this.runtimeState(runtime),
      entries,
    }
  }

  async prompt(runtimeSessionId: string, message: string): Promise<void> {
    const runtime = this.runtime(runtimeSessionId)
    if (runtime.status !== 'ready') {
      throw new Error(`Hermes Live runtime is not ready: ${runtime.status}`)
    }
    if (!runtime.nativeSessionId) throw new Error('Hermes Live runtime has no native session id')
    if (!message.trim()) throw new Error('Hermes Live message cannot be empty')

    await this.refreshActiveRun(runtime)
    if (runtime.activeRunId) {
      throw new Error('Hermes Live runtime already has an active run')
    }

    const runId = await this.client.createRun(runtime.nativeSessionId, message)
    runtime.activeRunId = runId
    const controller = new AbortController()
    runtime.streamAbort = controller
    runtime.events.publish({
      event: 'run.created',
      run_id: runId,
      session_id: runtime.nativeSessionId,
    })
    runtime.streamTask = this.consumeRun(runtime, runId, controller.signal)
  }

  subscribe(
    runtimeSessionId: string,
    listener: Parameters<LiveEventChannel['subscribe']>[0],
  ): () => void {
    return this.runtime(runtimeSessionId).events.subscribe(listener)
  }

  async interrupt(runtimeSessionId: string): Promise<unknown> {
    const runtime = this.runtime(runtimeSessionId)
    await this.refreshActiveRun(runtime)
    if (!runtime.activeRunId) return { status: 'idle' }
    const response = await this.client.stopRun(runtime.activeRunId)
    runtime.events.publish({
      event: 'run.stop.requested',
      run_id: runtime.activeRunId,
    })
    return response
  }

  async terminate(runtimeSessionId: string): Promise<void> {
    const runtime = this.runtime(runtimeSessionId)
    if (runtime.status === 'terminated') return
    runtime.status = 'terminating'
    runtime.events.publish({ type: 'runtime_status', status: 'terminating' })

    if (runtime.activeRunId) {
      await this.client.stopRun(runtime.activeRunId).catch(() => undefined)
    }
    runtime.streamAbort?.abort()
    await runtime.streamTask?.catch(() => undefined)

    runtime.activeRunId = undefined
    runtime.streamAbort = undefined
    runtime.streamTask = undefined
    runtime.status = 'terminated'
    runtime.events.publish({ type: 'runtime_status', status: 'terminated' })
    runtime.events.clear()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.all([...this.runtimes.keys()].map(id => this.terminate(id)))
  }

  private async consumeRun(
    runtime: OwnedRuntime,
    runId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const event of this.client.runEvents(runId, signal)) {
        if (runtime.activeRunId !== runId) return
        runtime.events.publish(event)
        const name = typeof event.event === 'string' ? event.event : ''
        if (['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(name)) {
          this.finishRun(runtime, runId)
        }
      }
    } catch (error) {
      if (!signal.aborted && runtime.status !== 'terminated') {
        runtime.events.publish({
          event: 'transport.error',
          run_id: runId,
          error: safeError(error),
        })
      }
    } finally {
      if (signal.aborted || runtime.status === 'terminated') return
      await this.refreshActiveRun(runtime).catch(() => undefined)
    }
  }

  private async refreshActiveRun(runtime: OwnedRuntime): Promise<void> {
    const runId = runtime.activeRunId
    if (!runId) return
    const state = await this.client.runState(runId)
    if (TERMINAL_RUN_STATUSES.has(state.status)) {
      runtime.events.publish({
        event: `run.${state.status}`,
        ...state,
      })
      this.finishRun(runtime, runId)
    }
  }

  private finishRun(runtime: OwnedRuntime, runId: string): void {
    if (runtime.activeRunId !== runId) return
    runtime.activeRunId = undefined
    runtime.streamAbort = undefined
    runtime.streamTask = undefined
  }

  private runtime(runtimeSessionId: string): OwnedRuntime {
    const runtime = this.runtimes.get(runtimeSessionId)
    if (!runtime) throw new Error(`Hermes Live runtime not found: ${runtimeSessionId}`)
    return runtime
  }

  private runtimeState(runtime: OwnedRuntime): LiveRuntimeState {
    return {
      runtimeSessionId: runtime.id,
      status: runtime.status,
      ...(runtime.nativeSessionId ? { nativeSessionId: runtime.nativeSessionId } : {}),
      isStreaming: Boolean(runtime.activeRunId),
      pendingMessageCount: 0,
    }
  }
}
