import { Worker } from 'node:worker_threads'
import type { NativeWorkerReadInput, NativeWorkerReadResult, NativeWorkerReply, NativeWorkerRequest } from './native-reader-worker-protocol'

const MAX_PENDING = 8
const REQUEST_TIMEOUT_MS = 30_000

export function resolveNativeReaderWorkerUrl(moduleUrl = import.meta.url): URL {
  return moduleUrl.endsWith('.mjs')
    ? new URL('./native-reader-worker.mjs', moduleUrl)
    : new URL('./native-reader-worker-source.mjs', moduleUrl)
}

export interface NativeReaderWorkerPort {
  supports(sourceId: string): boolean
  read(input: NativeWorkerReadInput, signal: AbortSignal): Promise<NativeWorkerReadResult>
}

interface Pending {
  complete(value: NativeWorkerReadResult): void
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
    return sourceId === 'pi' || sourceId === 'codex'
  }

  private ensureWorker(): Worker {
    if (this.disposed) throw new Error('Native Reader Worker already disposed')
    if (this.worker) return this.worker
    const worker = new Worker(this.workerUrl, { execArgv: [] })
    worker.unref()
    worker.on('message', (reply: NativeWorkerReply) => {
      if (!reply || reply.kind !== 'reply' || !Number.isSafeInteger(reply.id)) return
      this.pending.get(reply.id)?.complete(reply.result)
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

  async read(input: NativeWorkerReadInput, signal: AbortSignal): Promise<NativeWorkerReadResult> {
    signal.throwIfAborted()
    if (!this.supports(input.sourceId)) {
      return { state: 'unsupported', reason: 'source-not-supported-by-native-worker' }
    }
    if (this.pending.size >= MAX_PENDING) {
      return { state: 'unsupported', reason: 'native-worker-queue-full' }
    }
    const worker = this.ensureWorker()
    const id = ++this.sequence
    return new Promise<NativeWorkerReadResult>((resolve, reject) => {
      let done = false
      const cleanup = () => {
        this.pending.delete(id)
        signal.removeEventListener('abort', cancelled)
        clearTimeout(timeout)
      }
      const complete = (result: NativeWorkerReadResult) => {
        if (done) return
        done = true
        cleanup()
        resolve(result)
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
      this.pending.set(id, { complete, fail })
      signal.addEventListener('abort', cancelled, { once: true })
      if (signal.aborted) {
        cancelled()
        return
      }
      try {
        worker.postMessage({ kind: 'read', id, input } satisfies NativeWorkerRequest)
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Native reader worker delivery failed'))
      }
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const worker = this.worker
    this.worker = null
    for (const [, request] of this.pending) request.fail(new Error('Native Reader Worker stopped'))
    if (worker) await worker.terminate()
  }
}
