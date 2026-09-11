import { fork, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { deserialize } from 'node:v8'
import { discoverInstalledPiSdk } from './sdk-loader'
import type {
  PiLiveControls,
  PiLiveInitializationTiming,
  PiLiveQueueState,
  PiLiveRuntimeCapabilities,
  PiLiveRuntimeState,
  PiLiveSnapshot,
  PiLiveStartInput,
  PiLiveStreamingBehavior,
} from './types'

const PROTOCOL_VERSION = 1
const MAX_PENDING_REQUESTS = 128
const MAX_STDERR_TAIL = 64 * 1024
const MAX_STARTUP_OUTPUT_LINES = 80

type SnapshotTransferCommand = 'snapshotBegin' | 'snapshotChunk'

type WorkerCommand =
  | 'state' | SnapshotTransferCommand | 'controls' | 'setModel' | 'setThinkingLevel'
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

interface SnapshotTransferChunk {
  transferId: string
  sequence: number
  chunk: Uint8Array
  done: boolean
}

type SnapshotTransferRequest = (command: SnapshotTransferCommand, payload?: unknown) => Promise<unknown>

export interface PiRuntimeHandle {
  readonly processId?: number | undefined
  readonly capabilities?: PiLiveRuntimeCapabilities | undefined
  readonly initializationElapsedMs?: number | undefined
  readonly initializationTimings?: PiLiveInitializationTiming[] | undefined
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
  /** 在没有任务数据的空闲 Worker 中提前导入 SDK；失败不影响后续冷启动。 */
  preload?(): Promise<void>
  dispose?(): Promise<void>
  start(
    runtimeSessionId: string,
    input: PiLiveStartInput,
    signal: AbortSignal,
    onEvent: (event: Record<string, unknown>) => void,
    onExit: (error: Error) => void,
  ): Promise<PiRuntimeHandle>
}

interface PiSdkDescriptor {
  sdkEntry: string
  version?: string | undefined
}

interface WarmWorker {
  child: ChildProcess
  sdk: PiSdkDescriptor
}

function sanitizeDiagnostic(value: string): string {
  const home = homedir()
  return value
    .replace(/(?:api[_-]?key|token|authorization|password)\s*[:=]\s*\S+/gi, '[redacted]')
    .replaceAll(home, '<home>')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseSnapshotTransferChunk(value: unknown): SnapshotTransferChunk {
  const row = record(value)
  const transferId = typeof row.transferId === 'string' ? row.transferId : ''
  const sequence = typeof row.sequence === 'number' ? row.sequence : -1
  const chunk = row.chunk
  const done = row.done
  if (!transferId || !Number.isSafeInteger(sequence) || sequence < 0 || typeof done !== 'boolean') {
    throw new Error('Pi Runtime Worker returned an invalid snapshot transfer envelope')
  }
  if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
    throw new Error('Pi Runtime Worker returned an invalid snapshot transfer chunk')
  }
  return { transferId, sequence, chunk, done }
}

function parseSnapshot(value: unknown): PiLiveSnapshot {
  const row = record(value)
  const leafId = row.leafId
  if (!row.state || typeof row.state !== 'object' || Array.isArray(row.state) || !Array.isArray(row.entries)) {
    throw new Error('Pi Runtime Worker returned an invalid snapshot payload')
  }
  if (leafId !== null && typeof leafId !== 'string') {
    throw new Error('Pi Runtime Worker returned an invalid snapshot leaf id')
  }
  return value as PiLiveSnapshot
}

async function collectSnapshotTransfer(request: SnapshotTransferRequest, since?: string): Promise<PiLiveSnapshot> {
  const chunks: Buffer[] = []
  let page = parseSnapshotTransferChunk(await request('snapshotBegin', { since }))
  const transferId = page.transferId
  let expectedSequence = 0

  while (true) {
    if (page.transferId !== transferId) throw new Error('Pi Runtime Worker switched snapshot transfer ids')
    if (page.sequence !== expectedSequence) throw new Error('Pi Runtime Worker returned snapshot chunks out of order')
    expectedSequence += 1

    const chunk = Buffer.from(page.chunk)
    if (!chunk.length && !page.done) throw new Error('Pi Runtime Worker returned an empty non-terminal snapshot chunk')
    chunks.push(chunk)
    if (page.done) break
    page = parseSnapshotTransferChunk(await request('snapshotChunk', { transferId }))
  }

  try {
    return parseSnapshot(deserialize(Buffer.concat(chunks)))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Pi Runtime Worker returned an invalid snapshot')) throw error
    throw new Error(`Pi Runtime Worker snapshot transfer could not be decoded: ${error instanceof Error ? error.message : String(error)}`)
  }
}

class WorkerPiRuntimeHandle implements PiRuntimeHandle {
  private readonly pending = new Map<string, PendingRequest>()
  private requestSequence = 0
  private exited = false
  private stderrTail = ''
  private startupOutputActive = true
  private startupOutputCount = 0
  private startupOutputBuffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  private handshakeCapabilities?: PiLiveRuntimeCapabilities | undefined
  private handshakeElapsedMs?: number | undefined
  private handshakeTimings?: PiLiveInitializationTiming[] | undefined

  constructor(
    private readonly child: ChildProcess,
    private readonly runtimeSessionId: string,
    private readonly onEvent: (event: Record<string, unknown>) => void,
    private readonly onExit: (error: Error) => void,
  ) {
    child.on('message', value => this.receive(value))
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', value => this.captureStartupOutput('stdout', String(value)))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', value => {
      const text = String(value)
      this.stderrTail = `${this.stderrTail}${text}`.slice(-MAX_STDERR_TAIL)
      this.captureStartupOutput('stderr', text)
    })
    child.once('error', error => this.fail(error))
    child.once('close', (code, signal) => {
      if (this.exited) return
      const detail = sanitizeDiagnostic(this.stderrTail)
      const suffix = detail ? `: ${detail}` : ''
      this.fail(new Error(`Pi Runtime Worker exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})${suffix}`))
    })
  }

  private captureStartupOutput(stream: 'stdout' | 'stderr', chunk: string): void {
    if (!this.startupOutputActive) return
    const parts = `${this.startupOutputBuffers[stream]}${chunk}`.split(/\r?\n/)
    this.startupOutputBuffers[stream] = parts.pop() ?? ''
    for (const line of parts) this.emitStartupOutput(stream, line)
  }

  private emitStartupOutput(stream: 'stdout' | 'stderr', line: string): void {
    if (this.startupOutputCount >= MAX_STARTUP_OUTPUT_LINES) return
    const message = sanitizeDiagnostic(line).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    if (!message) return
    this.startupOutputCount += 1
    this.onEvent({ type: 'runtime_output', stream, message })
  }

  private finishStartupOutput(): void {
    if (!this.startupOutputActive) return
    for (const stream of ['stdout', 'stderr'] as const) {
      const pending = this.startupOutputBuffers[stream]
      this.startupOutputBuffers[stream] = ''
      if (pending) this.emitStartupOutput(stream, pending)
    }
    this.startupOutputActive = false
  }

  get processId(): number | undefined { return this.child.pid }
  get capabilities(): PiLiveRuntimeCapabilities | undefined { return this.handshakeCapabilities }
  get initializationElapsedMs(): number | undefined { return this.handshakeElapsedMs }
  get initializationTimings(): PiLiveInitializationTiming[] | undefined { return this.handshakeTimings }

  applyHandshake(value: unknown): void {
    const payload = record(value)
    const capabilityValue = record(payload.capabilities)
    if (typeof capabilityValue.protocolVersion === 'number') {
      this.handshakeCapabilities = capabilityValue as unknown as PiLiveRuntimeCapabilities
    }
    if (typeof payload.initializationElapsedMs === 'number' && Number.isFinite(payload.initializationElapsedMs)) {
      this.handshakeElapsedMs = Math.max(0, payload.initializationElapsedMs)
    }
    if (Array.isArray(payload.initializationTimings)) {
      this.handshakeTimings = payload.initializationTimings.flatMap(item => {
        const timing = record(item)
        return typeof timing.stage === 'string' && typeof timing.durationMs === 'number' && Number.isFinite(timing.durationMs)
          ? [{ stage: timing.stage, durationMs: Math.max(0, timing.durationMs) } as PiLiveInitializationTiming]
          : []
      })
    }
    this.finishStartupOutput()
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const envelope = value as WorkerEnvelope & { ok?: boolean; error?: string }
    if (envelope.version !== PROTOCOL_VERSION) {
      this.protocolViolation(`Pi Runtime Worker protocol version mismatch: ${String(envelope.version)}`)
      return
    }
    if (envelope.runtimeSessionId !== this.runtimeSessionId) {
      this.protocolViolation(`Pi Runtime Worker runtime id mismatch: ${envelope.runtimeSessionId}`)
      return
    }
    if (envelope.type === 'event') {
      if (envelope.payload && typeof envelope.payload === 'object') {
        this.onEvent(envelope.payload as Record<string, unknown>)
      }
      return
    }
    if (envelope.type !== 'response' || !envelope.requestId) {
      this.protocolViolation(`Unexpected Pi Runtime Worker envelope: ${envelope.type || 'missing type'}`)
      return
    }
    // initialize is correlated by WorkerPiRuntimeHost.start() before the handle is returned.
    if (envelope.requestId === 'initialize') return
    const pending = this.pending.get(envelope.requestId)
    if (!pending) {
      this.protocolViolation(`Unknown or duplicate Pi Runtime Worker response id: ${envelope.requestId}`)
      return
    }
    this.pending.delete(envelope.requestId)
    if (envelope.ok) pending.resolve(envelope.payload)
    else pending.reject(new Error(envelope.error || 'Pi Runtime Worker request failed'))
  }

  private protocolViolation(message: string): void {
    const error = new Error(message)
    this.fail(error)
    if (this.child.connected) this.child.disconnect()
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
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
        const pending = this.pending.get(requestId)
        this.pending.delete(requestId)
        pending?.reject(error)
      })
    })
  }

  state(): Promise<PiLiveRuntimeState> { return this.request('state') }
  snapshot(since?: string): Promise<PiLiveSnapshot> {
    return collectSnapshotTransfer((command, payload) => this.request(command, payload), since)
  }
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
    if (this.exited) return
    this.exited = true
    const error = new Error('Pi Runtime Worker terminated')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (this.child.connected) this.child.disconnect()
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
  }
}

export class WorkerPiRuntimeHost implements PiRuntimeHost {
  private warmWorker?: WarmWorker | undefined
  private warming?: Promise<void> | undefined

  private workerEntry(): string {
    return fileURLToPath(new URL('./worker-entry.mjs', import.meta.url))
  }

  private forkWorker(cwd: string): ChildProcess {
    const forkOptions = {
      cwd,
      env: process.env,
      // Worker 入口是纯 ESM，不继承 Daemon 的 tsx/inspect/input-type 参数。
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    } as Parameters<typeof fork>[2] & { windowsHide: boolean }
    return fork(this.workerEntry(), [], forkOptions)
  }

  private sameSdk(left: PiSdkDescriptor, right: PiSdkDescriptor): boolean {
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
    return normalize(left.sdkEntry) === normalize(right.sdkEntry) && left.version === right.version
  }

  /** 预热 Worker 不读取任务 cwd、不创建 Session，只导入 Host 已验证的 SDK。 */
  async preload(): Promise<void> {
    if (this.warmWorker || this.warming) return this.warming
    this.warming = (async () => {
      const discovered = await discoverInstalledPiSdk()
      const sdk: PiSdkDescriptor = { sdkEntry: discovered.sdkEntry, ...(discovered.version ? { version: discovered.version } : {}) }
      const child = this.forkWorker(process.cwd())
      try {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            child.off('message', message)
            child.off('error', failed)
            child.off('exit', exited)
            clearTimeout(timeout)
          }
          const failed = (error: Error) => { cleanup(); reject(error) }
          const exited = (code: number | null, signal: NodeJS.Signals | null) => {
            cleanup()
            reject(new Error(`Pi SDK prewarm Worker exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`))
          }
          const timeout = setTimeout(() => { cleanup(); reject(new Error('Pi SDK prewarm timed out')) }, 120_000)
          timeout.unref?.()
          const message = (value: unknown) => {
            const envelope = record(value) as unknown as WorkerEnvelope & { ok?: boolean; error?: string }
            if (envelope.version !== PROTOCOL_VERSION || envelope.runtimeSessionId !== '' || envelope.type !== 'response' || envelope.requestId !== 'prewarm') return
            cleanup()
            if (envelope.ok) resolve()
            else reject(new Error(envelope.error || 'Pi SDK prewarm failed'))
          }
          child.on('message', message)
          child.once('error', failed)
          child.once('exit', exited)
          child.send({ version: PROTOCOL_VERSION, runtimeSessionId: '', type: 'prewarm', requestId: 'prewarm', payload: { sdk } }, error => {
            if (!error) return
            cleanup()
            reject(error)
          })
        })
        if (child.exitCode !== null || child.signalCode !== null || !child.connected) throw new Error('Pi SDK prewarm Worker disconnected')
        const warm: WarmWorker = { child, sdk }
        this.warmWorker = warm
        child.once('close', () => { if (this.warmWorker === warm) this.warmWorker = undefined })
      } catch (error) {
        if (child.connected) child.disconnect()
        if (child.exitCode === null && child.signalCode === null) child.kill()
        throw error
      }
    })().finally(() => { this.warming = undefined })
    return this.warming
  }

  private takeWarmWorker(sdk: PiSdkDescriptor): ChildProcess | undefined {
    const warm = this.warmWorker
    if (!warm || !this.sameSdk(warm.sdk, sdk)) return undefined
    this.warmWorker = undefined
    if (warm.child.exitCode !== null || warm.child.signalCode !== null || !warm.child.connected) return undefined
    return warm.child
  }

  async dispose(): Promise<void> {
    const warm = this.warmWorker
    this.warmWorker = undefined
    if (!warm) return
    if (warm.child.connected) warm.child.disconnect()
    if (warm.child.exitCode === null && warm.child.signalCode === null) warm.child.kill()
  }

  async start(
    runtimeSessionId: string,
    input: PiLiveStartInput,
    signal: AbortSignal,
    onEvent: (event: Record<string, unknown>) => void,
    onExit: (error: Error) => void,
  ): Promise<PiRuntimeHandle> {
    // 可执行文件、npm shim 与 SDK 包只能在一个位置解析。Worker 只接收已经
    // 验证的 SDK 入口，避免父/子进程分别维护一套 PATH 与 shim 规则。
    const sdk = await discoverInstalledPiSdk(input.executable)
    const sdkDescriptor: PiSdkDescriptor = {
      sdkEntry: sdk.sdkEntry,
      ...(sdk.version ? { version: sdk.version } : {}),
    }
    const workerInput = {
      ...input,
      sdk: sdkDescriptor,
    }
    // 只领取从未创建 Session 的空闲 Worker。领取后立即尝试补位，失败则让下一次继续冷启动。
    const child = this.takeWarmWorker(sdkDescriptor) ?? this.forkWorker(input.cwd)
    void this.preload().catch(() => undefined)
    const handle = new WorkerPiRuntimeHandle(child, runtimeSessionId, onEvent, onExit)
    const abort = () => { if (child.exitCode === null && child.signalCode === null) child.kill() }
    signal.addEventListener('abort', abort, { once: true })
    const handshake = await new Promise<unknown>((resolve, reject) => {
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
        if (envelope.ok) resolve(envelope.payload)
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
      child.send({ version: PROTOCOL_VERSION, runtimeSessionId, type: 'initialize', requestId, payload: workerInput }, error => {
        if (!error) return
        cleanup()
        reject(error)
      })
    }).catch(async error => {
      signal.removeEventListener('abort', abort)
      await handle.terminate()
      throw error
    })
    handle.applyHandshake(handshake)
    signal.removeEventListener('abort', abort)
    return handle
  }
}

export const piLiveWorkerHostInternals = {
  collectSnapshotTransfer,
}
