import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

export interface PiRpcClientOptions {
  executable: string
  cwd: string
  args?: string[]
  commandTimeoutMs?: number
  onEvent?: (event: Record<string, unknown>) => void
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class StrictJsonlDecoder {
  private carry = Buffer.alloc(0)

  push(chunk: Buffer): string[] {
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk
    const lines: string[] = []
    let cursor = 0
    while (true) {
      const newline = data.indexOf(0x0a, cursor)
      if (newline < 0) break
      let line = data.subarray(cursor, newline)
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1)
      if (line.length > MAX_RPC_LINE_BYTES) throw new Error('Pi RPC record exceeds maximum line size')
      if (line.length) lines.push(line.toString('utf8'))
      cursor = newline + 1
    }
    this.carry = data.subarray(cursor)
    if (this.carry.length > MAX_RPC_LINE_BYTES) throw new Error('Pi RPC record exceeds maximum line size')
    return lines
  }

  finish(): string[] {
    if (!this.carry.length) return []
    const line = this.carry
    this.carry = Buffer.alloc(0)
    if (line.length > MAX_RPC_LINE_BYTES) throw new Error('Pi RPC record exceeds maximum line size')
    return [line.toString('utf8')]
  }
}

export class PiRpcClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly decoder = new StrictJsonlDecoder()
  private nextRequestId = 1
  private stderrTail = ''
  private closed = false

  constructor(private readonly options: PiRpcClientOptions) {}

  get pid(): number | undefined {
    return this.process?.pid
  }

  async start(): Promise<void> {
    if (this.process) return
    if (this.closed) throw new Error('Pi RPC client is closed')
    const child = spawn(this.options.executable, ['--mode', 'rpc', ...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.process = child

    child.stdout.on('data', chunk => {
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        for (const line of this.decoder.push(bytes)) this.handleLine(line)
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)))
        void this.close()
      }
    })
    child.stderr.on('data', chunk => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-MAX_STDERR_BYTES)
    })
    child.once('error', error => this.failAll(error))
    child.once('exit', (code, signal) => {
      const suffix = this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ''
      this.failAll(new Error(`Pi RPC exited code=${code ?? 'null'} signal=${signal ?? 'null'}${suffix}`))
      this.process = null
    })

    await new Promise<void>((resolve, reject) => {
      if (child.pid) {
        resolve()
        return
      }
      const onSpawn = () => { cleanup(); resolve() }
      const onError = (error: Error) => { cleanup(); reject(error) }
      const cleanup = () => {
        child.off('spawn', onSpawn)
        child.off('error', onError)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  async command<T extends Record<string, unknown> = Record<string, unknown>>(
    command: Record<string, unknown>,
  ): Promise<T> {
    const child = this.process
    if (!child || child.killed || !child.stdin.writable) throw new Error('Pi RPC process is not running')
    const id = `agentlens-${this.nextRequestId++}`
    const timeoutMs = this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi RPC command timed out: ${String(command.type ?? 'unknown')}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    child.stdin.write(`${JSON.stringify({ ...command, id })}\n`)
    return await response as T
  }

  private handleLine(line: string): void {
    let value: Record<string, unknown>
    try {
      const parsed = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      value = parsed as Record<string, unknown>
    } catch (error) {
      throw new Error(`Invalid Pi RPC JSON: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (value.type === 'response' && typeof value.id === 'string') {
      const pending = this.pending.get(value.id)
      if (!pending) return
      this.pending.delete(value.id)
      clearTimeout(pending.timer)
      if (value.success === false) {
        const message = typeof value.error === 'string'
          ? value.error
          : typeof value.message === 'string'
            ? value.message
            : `Pi RPC command failed: ${String(value.command ?? 'unknown')}`
        pending.reject(new Error(message))
      } else {
        pending.resolve(value)
      }
      return
    }

    this.options.onEvent?.(value)
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const child = this.process
    this.process = null
    this.failAll(new Error('Pi RPC client closed'))
    if (!child || child.killed) return
    child.stdin.end()
    child.kill('SIGTERM')
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
        resolve()
      }, 1500)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}
