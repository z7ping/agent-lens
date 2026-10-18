import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolveExecutable } from '@agent-lens/runtime-cordis'

export interface RpcMessage {
  method: string
  params: Record<string, unknown>
  id?: number | string
}
type Listener = (message: RpcMessage) => void
type Pending = {
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

/** One local App Server per adapter. Thread ownership stays with Codex. */
export class CodexRpc {
  private child?: ChildProcessWithoutNullStreams
  private opening?: Promise<void>
  private seq = 0
  private pending = new Map<number, Pending>()
  private listeners = new Set<Listener>()
  private buffer = ''
  private disposed = false
  private closing = false

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async available(): Promise<boolean> {
    return Boolean(await resolveExecutable('codex', { envVar: 'AGENT_LENS_CODEX_EXECUTABLE' }))
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error('Codex transport disposed')
    if (!this.opening) this.opening = this.open().catch(error => {
      this.opening = undefined
      this.child?.kill()
      throw error
    })
    return this.opening
  }

  private async open(): Promise<void> {
    const exe = await resolveExecutable('codex', { envVar: 'AGENT_LENS_CODEX_EXECUTABLE' })
    if (!exe) throw new Error('Codex executable not found')
    const child = spawn(exe, ['app-server'], {
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.closing = false
    this.buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consume(chunk))
    // Never include stderr (may contain sensitive details) in UI or persisted logs.
    child.stderr.resume()
    child.on('error', error => this.close(error))
    child.on('exit', code => this.close(new Error('Codex App Server exited: ' + String(code))))
    await this.send('initialize', {
      clientInfo: { name: 'agent_lens', title: 'AgentLens', version: '1.0.0' },
    })
    this.notify('initialized')
  }

  private write(value: Record<string, unknown>): void {
    if (!this.child || this.child.exitCode !== null || this.child.stdin.destroyed) {
      throw new Error('Codex App Server is unavailable')
    }
    this.child.stdin.write(JSON.stringify(value) + '\n')
  }

  private send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Codex RPC timeout: ' + method))
      }, 30_000)
      timeout.unref?.()
      this.pending.set(id, { resolve, reject, timeout })
      try { this.write({ id, method, params }) }
      catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.connect()
    return this.send(method, params)
  }

  notify(method: string): void { this.write({ method }) }
  respond(id: number | string, result: Record<string, unknown>): void {
    this.write({ id, result })
  }
  reject(id: number | string): void {
    this.write({ id, error: { code: -32601, message: 'Unsupported Codex server request' } })
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024 && !this.buffer.includes('\n')) {
      this.child?.kill()
      return
    }
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      try {
        const data = record(JSON.parse(line))
        if (data.id !== undefined && !data.method) {
          const id = Number(data.id)
          const waiting = this.pending.get(id)
          if (waiting) {
            clearTimeout(waiting.timeout)
            this.pending.delete(id)
            const error = record(data.error)
            if (data.error) waiting.reject(new Error(String(error.message || 'Codex RPC error')))
            else waiting.resolve(record(data.result))
          }
        } else if (typeof data.method === 'string') {
          const message: RpcMessage = {
            method: data.method, params: record(data.params),
            ...(typeof data.id === 'number' || typeof data.id === 'string' ? { id: data.id } : {}),
          }
          if (message.id !== undefined && !this.listeners.size) this.reject(message.id)
          for (const listener of this.listeners) listener(message)
        }
      } catch {
        // Ignore invalid transport frames; never crash the Daemon on malformed JSON.
      }
      index = this.buffer.indexOf('\n')
    }
  }

  private close(error: Error): void {
    if (this.closing) return
    this.closing = true
    this.opening = undefined
    for (const item of this.pending.values()) {
      clearTimeout(item.timeout)
      item.reject(error)
    }
    this.pending.clear()
    for (const listener of this.listeners) listener({
      method: 'transport/disconnected', params: { message: error.message },
    })
    this.child = undefined
  }

  dispose(): void {
    this.disposed = true
    const child = this.child
    this.close(new Error('Codex transport disposed'))
    child?.kill()
    this.listeners.clear()
  }
}
