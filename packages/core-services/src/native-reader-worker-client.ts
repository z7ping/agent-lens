import { Worker } from 'node:worker_threads'
import type {
  NativeWorkerReadInput, NativeWorkerReadResult,
  NativeWorkerHookReadInput, NativeWorkerHookReadResult,
  NativeWorkerReply, NativeWorkerRequest,
} from './native-reader-worker-protocol'

const MAX_PENDING = 8
const REQUEST_TIMEOUT_MS = 30_000

export function resolveNativeReaderWorkerUrl(moduleUrl = import.meta.url): URL {
  return moduleUrl.endsWith('.mjs')
    ? new URL('./native-reader-worker.mjs', moduleUrl)
    : new URL('../../../apps/daemon/src/native-reader/worker-source.mjs', moduleUrl)
}

export interface NativeReaderWorkerPort {
  supports(sourceId: string): boolean
  read(input: NativeWorkerReadInput, signal: AbortSignal): Promise<NativeWorkerReadResult>
  readHooks?(input: NativeWorkerHookReadInput, signal: AbortSignal): Promise<NativeWorkerHookReadResult>
}

interface Pending {
  responseKind: 'reply' | 'hook-reply'
  complete(value: NativeWorkerReadResult | NativeWorkerHookReadResult): void
  fail(error: Error): void
}

/** A bounded lazy worker. Never writes files/checkpoints and never keeps pages. */
export class NativeReaderWorkerClient implements NativeReaderWorkerPort {
  private worker: Worker | null = null
  private sequence = 0
  private disposed = false
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly workerUrl = resolveNativeReaderWorkerUrl()) {}

  supports(sourceId: string): boolean {
    return sourceId === 'pi' || sourceId === 'codex' || sourceId === 'claude-code' || sourceId === 'hermes' || sourceId === 'opencode'
  }

  private ensureWorker(): Worker {
    if (this.disposed) throw new Error('Native Reader Worker already disposed')
    if (this.worker) return this.worker
    const worker = new Worker(this.workerUrl, { execArgv: [] })
    worker.unref()
    worker.on('message', (reply: NativeWorkerReply) => {
      if (!reply || !Number.isSafeInteger(reply.id)) return
      const pending = this.pending.get(reply.id)
      if (pending?.responseKind === reply.kind) pending.complete(reply.result)
    })
    const failed = (error: Error) => {
      if (this.worker !== worker) return
      this.worker = null
      for (const [, request] of this.pending) request.fail(error)
    }
    worker.on('error', failed)
    worker.on('exit', code => failed(new Error(`Native Reader Worker exited with code ${code}`)))
    this.worker = worker
    return worker
  }

  private async dispatch<R extends NativeWorkerReadResult | NativeWorkerHookReadResult>(
    request: Extract<NativeWorkerRequest, {kind:'read' | 'read-hooks'}>,
    signal: AbortSignal,
  ): Promise<R> {
    signal.throwIfAborted()
    if (!this.supports(request.input.sourceId)) {
      return { state: 'unsupported', reason: 'source-not-supported-by-native-worker' } as R
    }
    if (this.pending.size >= MAX_PENDING) {
      return { state: 'unsupported', reason: 'native-worker-queue-full' } as R
    }
    const worker = this.ensureWorker()
    const id = ++this.sequence
    return new Promise<R>((resolve, reject) => {
      let done = false
      const cleanup = () => {
        this.pending.delete(id)
        signal.removeEventListener('abort', cancelled)
        clearTimeout(timeout)
      }
      const complete = (result: NativeWorkerReadResult | NativeWorkerHookReadResult) => {
        if (done) return
        done = true
        cleanup()
        resolve(result as R)
      }
      const fail = (error: Error) => {
        if (done) return
        done = true
        cleanup()
        reject(error)
      }
      const cancelled = () => {
        worker.postMessage({ kind: 'cancel', id } satisfies NativeWorkerRequest)
        fail(signal.reason instanceof Error ? signal.reason : new Error('Native reader request aborted'))
      }
      const timeout = setTimeout(() => {
        worker.postMessage({ kind: 'cancel', id } satisfies NativeWorkerRequest)
        fail(new Error('Native reader request exceeded timeout'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { responseKind: request.kind === 'read' ? 'reply' : 'hook-reply', complete, fail })
      signal.addEventListener('abort', cancelled, { once: true })
      if (signal.aborted) {
        cancelled()
        return
      }
      try {
        worker.postMessage({ ...request, id } satisfies NativeWorkerRequest)
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Native reader worker delivery failed'))
      }
    })
  }

  read(input: NativeWorkerReadInput, signal: AbortSignal): Promise<NativeWorkerReadResult> {
    return this.dispatch<NativeWorkerReadResult>({kind:'read',id:0,input},signal)
  }

  readHooks(input: NativeWorkerHookReadInput, signal: AbortSignal): Promise<NativeWorkerHookReadResult> {
    return this.dispatch<NativeWorkerHookReadResult>({kind:'read-hooks',id:0,input},signal)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const worker = this.worker
    this.worker = null
    for (const [, request] of this.pending) request.fail(new Error('Native Reader Worker stopped'))
    if (worker) await worker.terminate()
  }
}
