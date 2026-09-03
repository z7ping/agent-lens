import { fork, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type {
  PiLiveControls,
  PiLiveQueueState,
  PiLiveRuntimeState,
  PiLiveSnapshot,
  PiLiveStartInput,
  PiLiveStreamingBehavior,
} from './types'

const PROTOCOL_VERSION = 1
const MAX_PENDING_REQUESTS = 128
const MAX_STDERR_TAIL = 64 * 1024

type WorkerCommand =
  | 'state' | 'snapshot' | 'controls' | 'setModel' | 'setThinkingLevel'
  | 'prompt' | 'steer' | 'followUp' | 'clearQueue' | 'abort'
  | 'extensionResponse' | 'terminate'

interface WorkerEnvelope {
  version: number
  runtimeSessionId: string
  type: string
  requestId?: string
  payload?: unknown
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

export interface PiRuntimeHandle {
  readonly processId?: number | undefined
  state(): Promise<PiLiveRuntimeState>
  snapshot(since?: string): Promise<PiLiveSnapshot>
  controls(): Promise<PiLiveControls>
  setModel(provider: string, modelId: string): Promise<PiLiveRuntimeState>
  setThinkingLevel(level: string): Promise<PiLiveRuntimeState>
  prompt(message: string, behavior?: PiLiveStreamingBehavior): Promise<void>
  steer(message: string): Promise<void>
  followUp(message: string): Promise<void>
  clearQueue(): Promise<PiLiveQueueState>
  abort(restoreQueue?: boolean): Promise<PiLiveQueueState>
  respondToExtension(requestId: string, response: unknown): Promise<void>
  terminate(): Promise<void>
}

export interface PiRuntimeHost {
  start(
    runtimeSessionId: string,
    input: PiLiveStartInput,
    signal: AbortSignal,
    onEvent: (event: Record<string, unknown>) => void,
    onExit: (error: Error) => void,
  ): Promise<PiRuntimeHandle>
}

function sanitizeDiagnostic(value: string): string {
  const home = homedir()
  return value
    .replace(/(?:api[_-]?key|token|authorization|password)\s*[:=]\s*\S+/gi, '[redacted]')
    .replaceAll(home, '<home>')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

class WorkerPiRuntimeHandle implements PiRuntimeHandle {
  private readonly pending = new Map<string, PendingRequest>()
  private requestSequence = 0
  private exited = false
  private stderrTail = ''

  constructor(
    private readonly child: ChildProcess,
    private readonly runtimeSessionId: string,
    private readonly onEvent: (event: Record<string, unknown>) => void,
    private readonly onExit: (error: Error) => void,
  ) {
    child.on('message', value => this.receive(value))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', value => {
      this.stderrTail = `${this.stderrTail}${String(value)}`.slice(-MAX_STDERR_TAIL)
    })
    child.once('error', error => this.fail(error))
    child.once('close', (code, signal) => {
      if (this.exited) return
      const detail = sanitizeDiagnostic(this.stderrTail)
      const suffix = detail ? `: ${detail}` : ''
      this.fail(new Error(`Pi Runtime Worker exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})${suffix}`))
    })
  }

  get processId(): number | undefined { return this.child.pid }

  private receive(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const envelope = value as WorkerEnvelope & { ok?: boolean; error?: string }
    if (envelope.version !== PROTOCOL_VERSION || envelope.runtimeSessionId !== this.runtimeSessionId) return
    if (envelope.type === 'event') {
      if (envelope.payload && typeof envelope.payload === 'object') {
        this.onEvent(envelope.payload as Record<string, unknown>)
      }
      return
    }
    if (envelope.type !== 'response' || !envelope.requestId) return
    const pending = this.pending.get(envelope.requestId)
    if (!pending) return
    this.pending.delete(envelope.requestId)
    if (envelope.ok) pending.resolve(envelope.payload)
    else pending.reject(new Error(envelope.error || 'Pi Runtime Worker request failed'))
  }

  private fail(error: Error): void {
    if (this.exited) return
    this.exited = true
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.onExit(error)
  }

  private request<T>(command: WorkerCommand, payload?: unknown): Promise<T> {
    if (this.exited || !this.child.connected) return Promise.reject(new Error('Pi Runtime Worker is not connected'))
    if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new Error('Pi Runtime Worker request queue is full'))
    const requestId = `${++this.requestSequence}`
    const envelope: WorkerEnvelope = {
      version: PROTOCOL_VERSION,
      runtimeSessionId: this.runtimeSessionId,
      type: 'request',
      requestId,
      payload: { command, value: payload },
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: value => resolve(value as T), reject })
      this.child.send(envelope, error => {
        if (!error) return
        this.pending.delete(requestId)
        reject(error)
      })
    })
  }

  state(): Promise<PiLiveRuntimeState> { return this.request('state') }
  snapshot(since?: string): Promise<PiLiveSnapshot> { return this.request('snapshot', { since }) }
  controls(): Promise<PiLiveControls> { return this.request('controls') }
  setModel(provider: string, modelId: string): Promise<PiLiveRuntimeState> { return this.request('setModel', { provider, modelId }) }
  setThinkingLevel(level: string): Promise<PiLiveRuntimeState> { return this.request('setThinkingLevel', { level }) }
  prompt(message: string, behavior?: PiLiveStreamingBehavior): Promise<void> { return this.request('prompt', { message, behavior }) }
  steer(message: string): Promise<void> { return this.request('steer', { message }) }
  followUp(message: string): Promise<void> { return this.request('followUp', { message }) }
  clearQueue(): Promise<PiLiveQueueState> { return this.request('clearQueue') }
  abort(restoreQueue = true): Promise<PiLiveQueueState> { return this.request('abort', { restoreQueue }) }
  respondToExtension(requestId: string, response: unknown): Promise<void> { return this.request('extensionResponse', { requestId, response }) }

  async terminate(): Promise<void> {
    if (this.exited) return
    await this.request<void>('terminate').catch(() => undefined)
    this.exited = true
    this.child.disconnect()
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
  }
}

export class WorkerPiRuntimeHost implements PiRuntimeHost {
  async start(
    runtimeSessionId: string,
    input: PiLiveStartInput,
    signal: AbortSignal,
    onEvent: (event: Record<string, unknown>) => void,
    onExit: (error: Error) => void,
  ): Promise<PiRuntimeHandle> {
    const entry = fileURLToPath(new URL('./worker-entry.mjs', import.meta.url))
    const forkOptions = {
      cwd: input.cwd,
      env: process.env,
      // Worker 入口是纯 ESM，不继承 Daemon 的 tsx/inspect/input-type 参数。
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    } as Parameters<typeof fork>[2] & { windowsHide: boolean }
    const child = fork(entry, [], forkOptions)
    const handle = new WorkerPiRuntimeHandle(child, runtimeSessionId, onEvent, onExit)
    const abort = () => { if (child.exitCode === null && child.signalCode === null) child.kill() }
    signal.addEventListener('abort', abort, { once: true })
    await new Promise<void>((resolve, reject) => {
      const requestId = 'initialize'
      const cleanup = () => {
        child.off('message', listener)
        child.off('exit', exited)
        clearTimeout(timeout)
      }
      const exited = (code: number | null, exitSignal: NodeJS.Signals | null) => {
        cleanup()
        reject(new Error(`Pi Runtime Worker exited during initialization (code=${code ?? 'null'}, signal=${exitSignal ?? 'none'})`))
      }
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Pi Runtime Worker initialization handshake timed out'))
      }, 120_000)
      timeout.unref?.()
      const listener = (value: unknown) => {
        if (!value || typeof value !== 'object') return
        const envelope = value as WorkerEnvelope & { ok?: boolean; error?: string }
        if (envelope.version !== PROTOCOL_VERSION || envelope.runtimeSessionId !== runtimeSessionId || envelope.requestId !== requestId) return
        cleanup()
        if (envelope.ok) resolve()
        else reject(new Error(envelope.error || 'Pi Runtime Worker initialization failed'))
      }
      child.on('message', listener)
      child.once('exit', exited)
      if (signal.aborted) {
        cleanup()
        abort()
        reject(new Error('Pi Runtime Worker initialization was cancelled'))
        return
      }
      child.send({ version: PROTOCOL_VERSION, runtimeSessionId, type: 'initialize', requestId, payload: input }, error => {
        if (!error) return
        cleanup()
        reject(error)
      })
    }).catch(async error => {
      signal.removeEventListener('abort', abort)
      await handle.terminate()
      throw error
    })
    signal.removeEventListener('abort', abort)
    return handle
  }
}
