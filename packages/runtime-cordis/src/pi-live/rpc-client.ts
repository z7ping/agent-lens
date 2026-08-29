import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'

const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

export interface PiRpcClientOptions {
  executable: string
  cwd: string
  args?: string[]
  /** Tests may replace the default `--mode rpc` prefix without changing production behavior. */
  launchPrefixArgs?: string[]
  commandTimeoutMs?: number
  onEvent?: (event: Record<string, unknown>) => void
  onExit?: (error: Error) => void
}

interface PendingRequest {
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface PiSpawnSpec {
  command: string
  args: string[]
  kind: 'direct' | 'windows-npm-shim'
}

async function regularFile(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function resolveWindowsNpmShimNodeEntry(executable: string): Promise<string | undefined> {
  let source: string
  try {
    source = await readFile(executable, 'utf8')
  } catch {
    return undefined
  }

  const pattern = /%(?:~dp0|dp0%)([^"\r\n]*?\.(?:mjs|cjs|js))/ig
  for (const match of source.matchAll(pattern)) {
    const suffix = match[1]
    if (!suffix) continue
    const normalized = suffix
      .replace(/^[\\/]+/, '')
      .replace(/[\\/]/g, sep)
    const candidate = resolve(dirname(executable), normalized)
    if (await regularFile(candidate)) return candidate
  }
  return undefined
}

export async function resolvePiSpawnSpec(
  executable: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): Promise<PiSpawnSpec> {
  const extension = extname(executable).toLowerCase()
  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    const entry = await resolveWindowsNpmShimNodeEntry(executable)
    if (!entry) {
      throw new Error(
        `Unable to resolve the Node entry behind Pi Windows shim: ${executable}. `
        + 'Set PI_BIN to pi.exe or to a standard npm-installed Pi shim.',
      )
    }
    return { command: process.execPath, args: [entry, ...args], kind: 'windows-npm-shim' }
  }
  return { command: executable, args, kind: 'direct' }
}

export class StrictJsonlDecoder {
  private carry: Buffer<ArrayBufferLike> = Buffer.alloc(0)

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
  private exitNotified = false

  constructor(private readonly options: PiRpcClientOptions) {}

  get pid(): number | undefined {
    return this.process?.pid
  }

  async start(): Promise<void> {
    if (this.process) return
    if (this.closed) throw new Error('Pi RPC client is closed')
    const prefix = this.options.launchPrefixArgs ?? ['--mode', 'rpc']
    const launch = await resolvePiSpawnSpec(
      this.options.executable,
      [...prefix, ...(this.options.args ?? [])],
    )
    const child = spawn(launch.command, launch.args, {
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
        const failure = error instanceof Error ? error : new Error(String(error))
        this.failAll(failure)
        this.notifyExit(failure)
        void this.close()
      }
    })
    child.stderr.on('data', chunk => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-MAX_STDERR_BYTES)
    })
    child.once('error', error => {
      this.failAll(error)
      this.notifyExit(error)
    })
    child.once('exit', (code, signal) => {
      const suffix = this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ''
      const failure = new Error(`Pi RPC exited code=${code ?? 'null'} signal=${signal ?? 'null'}${suffix}`)
      this.failAll(failure)
      this.process = null
      this.notifyExit(failure)
    })

    await new Promise<void>((resolveStart, reject) => {
      if (child.pid) {
        resolveStart()
        return
      }
      const onSpawn = () => { cleanup(); resolveStart() }
      const onError = (error: Error) => { cleanup(); reject(error) }
      const cleanup = () => {
        child.off('spawn', onSpawn)
        child.off('error', onError)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  send(message: Record<string, unknown>): void {
    const child = this.process
    if (!child || !child.stdin.writable) throw new Error('Pi RPC process is not running')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  async command<T extends Record<string, unknown> = Record<string, unknown>>(
    command: Record<string, unknown>,
  ): Promise<T> {
    const child = this.process
    if (!child || !child.stdin.writable) throw new Error('Pi RPC process is not running')
    const id = `agentlens-${this.nextRequestId++}`
    const timeoutMs = this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    const response = new Promise<Record<string, unknown>>((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi RPC command timed out: ${String(command.type ?? 'unknown')}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolveResponse, reject, timer })
    })
    this.send({ ...command, id })
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

  private notifyExit(error: Error): void {
    if (this.closed || this.exitNotified) return
    this.exitNotified = true
    this.options.onExit?.(error)
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
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.stdin.end()
    child.kill('SIGTERM')
    await new Promise<void>(resolveClose => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveClose()
      }
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        finish()
      }, 1500)
      child.once('exit', finish)
    })
  }
}
