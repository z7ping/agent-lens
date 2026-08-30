import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type {
  PiLiveAvailability,
  PiLiveControls,
  PiLiveModelOption,
  PiLiveQueueState,
  PiLiveRuntimeEvent,
  PiLiveRuntimeListener,
  PiLiveRuntimeState,
  PiLiveService,
  PiLiveSnapshot,
  PiLiveStartInput,
  PiLiveStreamingBehavior,
} from './types'
import { PiRpcClient } from './rpc-client'

interface OwnedRuntime {
  id: string
  client: PiRpcClient
  listeners: Set<PiLiveRuntimeListener>
  sequence: number
  input: PiLiveStartInput
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function modelOptions(value: unknown): PiLiveModelOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const model = record(item)
    const provider = stringValue(model.provider)
    const id = stringValue(model.id)
    if (!provider || !id) return []
    return [{
      provider,
      id,
      ...(stringValue(model.name) ? { name: stringValue(model.name) } : {}),
      ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
    }]
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function findPiExecutable(explicit?: string): Promise<string | undefined> {
  if (explicit && await exists(explicit)) return explicit
  const configured = process.env.PI_BIN?.trim()
  if (configured && await exists(configured)) return configured
  const names = process.platform === 'win32' ? ['pi.exe', 'pi.cmd', 'pi.bat'] : ['pi']
  const pathValue = process.env.PATH ?? ''
  for (const root of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(root, name)
      if (await exists(candidate)) return candidate
    }
  }
  return undefined
}

export class DefaultPiLiveService implements PiLiveService {
  private readonly runtimes = new Map<string, OwnedRuntime>()
  private disposed = false

  async availability(): Promise<PiLiveAvailability> {
    const executable = await findPiExecutable()
    return executable
      ? { available: true, executable }
      : { available: false, reason: 'Pi executable was not found in PATH or PI_BIN' }
  }

  async list(): Promise<PiLiveRuntimeState[]> {
    const states = await Promise.allSettled([...this.runtimes.keys()].map(id => this.state(id)))
    return states.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  }

  async start(input: PiLiveStartInput): Promise<PiLiveRuntimeState> {
    if (this.disposed) throw new Error('Pi Live service is disposed')
    const executable = await findPiExecutable(input.executable)
    if (!executable) throw new Error('Pi executable was not found')
    if (!input.cwd) throw new Error('Pi Live requires a working directory')

    const runtimeSessionId = randomUUID()
    const args: string[] = []
    if (input.provider) args.push('--provider', input.provider)
    if (input.model) args.push('--model', input.model)
    if (input.name) args.push('--name', input.name)
    if (input.sessionDir) args.push('--session-dir', input.sessionDir)

    const listeners = new Set<PiLiveRuntimeListener>()
    const runtime: OwnedRuntime = {
      id: runtimeSessionId,
      client: null as unknown as PiRpcClient,
      listeners,
      sequence: 0,
      input,
    }
    const client = new PiRpcClient({
      executable,
      cwd: input.cwd,
      args,
      onEvent: event => this.publish(runtime, event),
    })
    runtime.client = client
    this.runtimes.set(runtimeSessionId, runtime)

    try {
      await client.start()
      if (input.sessionPath) await client.command({ type: 'switch_session', sessionPath: input.sessionPath })
      return await this.state(runtimeSessionId)
    } catch (error) {
      this.runtimes.delete(runtimeSessionId)
      await client.close().catch(() => undefined)
      throw error
    }
  }

  async state(runtimeSessionId: string): Promise<PiLiveRuntimeState> {
    const runtime = this.requireRuntime(runtimeSessionId)
    const response = await runtime.client.command({ type: 'get_state' })
    const data = record(response.data)
    return {
      runtimeSessionId,
      ...(stringValue(data.sessionId) ? { nativeSessionId: stringValue(data.sessionId) } : {}),
      ...(stringValue(data.sessionFile) ? { sessionFile: stringValue(data.sessionFile) } : {}),
      ...(stringValue(data.sessionName) ? { sessionName: stringValue(data.sessionName) } : {}),
      ...(data.model === undefined ? {} : { model: data.model }),
      ...(stringValue(data.thinkingLevel) ? { thinkingLevel: stringValue(data.thinkingLevel) } : {}),
      isStreaming: data.isStreaming === true,
      isCompacting: data.isCompacting === true,
      pendingMessageCount: numberValue(data.pendingMessageCount),
      processId: runtime.client.pid,
    }
  }

  async snapshot(runtimeSessionId: string, since?: string): Promise<PiLiveSnapshot> {
    const runtime = this.requireRuntime(runtimeSessionId)
    const [state, entriesResponse] = await Promise.all([
      this.state(runtimeSessionId),
      runtime.client.command({ type: 'get_entries', ...(since ? { since } : {}) }),
    ])
    const data = record(entriesResponse.data)
    const entries = Array.isArray(data.entries) ? data.entries : []
    const leafId = typeof data.leafId === 'string' ? data.leafId : null
    return { state: { ...state, leafId }, entries, leafId }
  }

  async controls(runtimeSessionId: string): Promise<PiLiveControls> {
    const runtime = this.requireRuntime(runtimeSessionId)
    const [modelsResponse, thinkingResponse] = await Promise.all([
      runtime.client.command({ type: 'get_available_models' }),
      runtime.client.command({ type: 'get_available_thinking_levels' }),
    ])
    const modelsData = record(modelsResponse.data)
    const thinkingData = record(thinkingResponse.data)
    return {
      models: modelOptions(modelsData.models),
      thinkingLevels: Array.isArray(thinkingData.levels)
        ? thinkingData.levels.filter((item): item is string => typeof item === 'string' && Boolean(item))
        : [],
    }
  }

  async setModel(runtimeSessionId: string, provider: string, modelId: string): Promise<PiLiveRuntimeState> {
    if (!provider.trim() || !modelId.trim()) throw new Error('Pi model provider and modelId are required')
    const runtime = this.requireRuntime(runtimeSessionId)
    await runtime.client.command({ type: 'set_model', provider: provider.trim(), modelId: modelId.trim() })
    return await this.state(runtimeSessionId)
  }

  async setThinkingLevel(runtimeSessionId: string, level: string): Promise<PiLiveRuntimeState> {
    if (!level.trim()) throw new Error('Pi thinking level is required')
    const runtime = this.requireRuntime(runtimeSessionId)
    await runtime.client.command({ type: 'set_thinking_level', level: level.trim() })
    return await this.state(runtimeSessionId)
  }

  async prompt(runtimeSessionId: string, message: string, behavior?: PiLiveStreamingBehavior): Promise<void> {
    if (!message.trim()) return
    await this.requireRuntime(runtimeSessionId).client.command({
      type: 'prompt',
      message,
      ...(behavior ? { streamingBehavior: behavior } : {}),
    })
  }

  async steer(runtimeSessionId: string, message: string): Promise<void> {
    if (!message.trim()) return
    await this.requireRuntime(runtimeSessionId).client.command({ type: 'steer', message })
  }

  async followUp(runtimeSessionId: string, message: string): Promise<void> {
    if (!message.trim()) return
    await this.requireRuntime(runtimeSessionId).client.command({ type: 'follow_up', message })
  }

  async clearQueue(runtimeSessionId: string): Promise<PiLiveQueueState> {
    const response = await this.requireRuntime(runtimeSessionId).client.command({ type: 'clear_queue' })
    return this.queueFromResponse(response)
  }

  async abort(runtimeSessionId: string, options: { restoreQueue?: boolean } = {}): Promise<PiLiveQueueState> {
    const runtime = this.requireRuntime(runtimeSessionId)
    const queue = options.restoreQueue === false
      ? { steering: [], followUp: [] }
      : await this.clearQueue(runtimeSessionId)
    await runtime.client.command({ type: 'abort' })
    return queue
  }

  async respondToExtension(runtimeSessionId: string, requestId: string, response: unknown): Promise<void> {
    if (!requestId) throw new Error('Pi extension request id is required')
    this.requireRuntime(runtimeSessionId).client.send({
      type: 'extension_ui_response',
      id: requestId,
      ...record(response),
    })
  }

  subscribe(runtimeSessionId: string, listener: PiLiveRuntimeListener): () => void {
    const runtime = this.requireRuntime(runtimeSessionId)
    runtime.listeners.add(listener)
    return () => runtime.listeners.delete(listener)
  }

  async terminate(runtimeSessionId: string): Promise<void> {
    const runtime = this.runtimes.get(runtimeSessionId)
    if (!runtime) return
    this.runtimes.delete(runtimeSessionId)
    runtime.listeners.clear()
    await runtime.client.close()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const ids = [...this.runtimes.keys()]
    await Promise.allSettled(ids.map(id => this.terminate(id)))
  }

  private requireRuntime(runtimeSessionId: string): OwnedRuntime {
    const runtime = this.runtimes.get(runtimeSessionId)
    if (!runtime) throw new Error(`Unknown Pi Live runtime session: ${runtimeSessionId}`)
    return runtime
  }

  private publish(runtime: OwnedRuntime, event: Record<string, unknown>): void {
    runtime.sequence += 1
    const value: PiLiveRuntimeEvent = {
      runtimeSessionId: runtime.id,
      sequence: runtime.sequence,
      receivedAt: new Date().toISOString(),
      event,
    }
    for (const listener of runtime.listeners) listener(value)
  }

  private queueFromResponse(response: Record<string, unknown>): PiLiveQueueState {
    const data = record(response.data)
    return {
      steering: Array.isArray(data.steering) ? data.steering.filter((item): item is string => typeof item === 'string') : [],
      followUp: Array.isArray(data.followUp) ? data.followUp.filter((item): item is string => typeof item === 'string') : [],
    }
  }
}
