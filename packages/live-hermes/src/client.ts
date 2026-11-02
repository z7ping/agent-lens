import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { LiveSnapshotWindow, LiveSnapshotPage } from '@agent-lens/core'
import { hermesHistoryPage, hermesHistoryQuery } from './history-page.js'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { parse as parseYaml } from 'yaml'

export interface HermesApiClientConfig {
  apiUrl?: string
  apiKey?: string
  envFiles?: readonly string[]
}

export interface ResolvedHermesApiClientConfig {
  apiUrl: string
  apiKey?: string
}

export interface HermesRunState extends Record<string, unknown> {
  run_id: string
  status: string
  session_id?: string
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function textField(value: unknown, ...names: string[]): string | undefined {
  const record = asRecord(value)
  for (const name of names) {
    const field = record[name]
    if (typeof field === 'string' && field.trim()) return field.trim()
  }
  return undefined
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map(value => value!.trim()))]
}

interface HermesApiFileSettings {
  apiKey?: string
  host?: string
  port?: string
}

async function envSettingsFromFiles(paths: readonly string[]): Promise<HermesApiFileSettings> {
  for (const path of paths) {
    try {
      const parsed = parseEnv(await readFile(path, 'utf8'))
      const apiKey = parsed.API_SERVER_KEY?.trim()
      const host = parsed.API_SERVER_HOST?.trim()
      const port = parsed.API_SERVER_PORT?.trim()
      if (apiKey || host || port) {
        return {
          ...(apiKey ? { apiKey } : {}),
          ...(host ? { host } : {}),
          ...(port ? { port } : {}),
        }
      }
    } catch {
      // Hermes config discovery is best effort; availability reports the actionable failure.
    }
  }
  return {}
}

async function yamlSettingsFromFiles(paths: readonly string[]): Promise<HermesApiFileSettings> {
  for (const path of paths) {
    try {
      const config = asRecord(parseYaml(await readFile(path, 'utf8')))
      const gateway = asRecord(config.gateway)
      const apiServer = asRecord(gateway.api_server)
      const apiKey = textField(apiServer, 'key')
      const host = textField(apiServer, 'host')
      const rawPort = apiServer.port
      const port = typeof rawPort === 'number' && Number.isFinite(rawPort)
        ? String(rawPort)
        : typeof rawPort === 'string' && rawPort.trim()
          ? rawPort.trim()
          : undefined
      if (apiKey || host || port) {
        return {
          ...(apiKey ? { apiKey } : {}),
          ...(host ? { host } : {}),
          ...(port ? { port } : {}),
        }
      }
    } catch {
      // Use the next standard Hermes config location.
    }
  }
  return {}
}

function clientHost(value: string | undefined): string {
  const host = value?.trim() || '127.0.0.1'
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return '127.0.0.1'
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

export async function resolveHermesApiClientConfig(
  config: HermesApiClientConfig = {},
): Promise<ResolvedHermesApiClientConfig> {
  // An explicit Hermes home/profile must never inherit credentials from another installation.
  const roots = unique(process.env.HERMES_HOME
    ? [process.env.HERMES_HOME]
    : [
      join(homedir(), '.hermes'),
      process.platform === 'win32' && process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'hermes')
        : undefined,
    ])
  const envFiles = unique([
    ...(config.envFiles ?? []),
    ...roots.map(root => join(root, '.env')),
  ])
  const configFiles = roots.map(root => join(root, 'config.yaml'))
  const [fileEnv, fileConfig] = await Promise.all([
    envSettingsFromFiles(envFiles),
    yamlSettingsFromFiles(configFiles),
  ])

  const port = process.env.HERMES_API_PORT?.trim()
    || process.env.API_SERVER_PORT?.trim()
    || fileEnv.port
    || fileConfig.port
    || '8642'
  const host = process.env.API_SERVER_HOST?.trim()
    || fileEnv.host
    || fileConfig.host
  const apiUrl = (config.apiUrl
    ?? process.env.HERMES_API_URL
    ?? `http://${clientHost(host)}:${port}`)
    .replace(/\/+$/, '')

  const apiKey = config.apiKey?.trim()
    || process.env.HERMES_API_KEY?.trim()
    || process.env.API_SERVER_KEY?.trim()
    || fileEnv.apiKey
    || fileConfig.apiKey

  return {
    apiUrl,
    ...(apiKey ? { apiKey } : {}),
  }
}

export class HermesApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'HermesApiError'
  }
}

export class HermesApiClient {
  private apiUrl: string
  private apiKey: string | undefined

  constructor(config: ResolvedHermesApiClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, '')
    this.apiKey = config.apiKey
  }

  /** Refresh credentials after explicit initialization without restarting AgentLens. */
  reconfigure(config: ResolvedHermesApiClientConfig): void {
    this.apiUrl = config.apiUrl.replace(/\/+$/, '')
    this.apiKey = config.apiKey
  }

  get configured(): boolean {
    return Boolean(this.apiKey)
  }

  async capabilities(): Promise<Record<string, unknown>> {
    return asRecord(await this.requestJson('/v1/capabilities'))
  }

  async createSession(input: { title?: string } = {}): Promise<string> {
    const response = asRecord(await this.requestJson('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      }),
    }))
    const session = asRecord(response.session)
    const id = textField(session, 'id', 'session_id')
    if (!id) throw new HermesApiError('Hermes session create response has no session id')
    return id
  }

  /** Bounded, bidirectional paging through Hermes' native offset API. */
  async sessionMessagesPage(
    sessionId: string,
    window: LiveSnapshotWindow = {},
  ): Promise<{ entries: unknown[]; page: LiveSnapshotPage }> {
    const query = hermesHistoryQuery(window)
    const base = `/api/sessions/${encodeURIComponent(sessionId)}/messages`
    const read = async (offset: number, limit: number): Promise<unknown[]> => {
      const params = new URLSearchParams({
        order: query.order,
        offset: String(offset),
        limit: String(limit),
        include_compacted: 'true',
      })
      const response = asRecord(await this.requestJson(`${base}?${params}`))
      const rows = Array.isArray(response.data) ? response.data
        : Array.isArray(response.messages) ? response.messages : []
      return rows.map(value => {
        const record = asRecord(value)
        const id = record.id
        return typeof id === 'number' && Number.isSafeInteger(id)
          ? { ...record, id: String(id) } : value
      })
    }
    const entries = await read(query.offset, query.limit)
    // A full last page is not proof older/newer rows exist.
    const more = entries.length === query.limit
      && (await read(query.offset + entries.length, 1)).length > 0
    return { entries, page: hermesHistoryPage(query, entries, more) }
  }

  /** Compatibility helper: most recent bounded page, in chronological order. */
  async sessionMessages(sessionId: string): Promise<unknown[]> {
    return (await this.sessionMessagesPage(sessionId, { edge: 'latest', limit: 500 })).entries
  }

  async createRun(sessionId: string, input: string): Promise<string> {
    const response = asRecord(await this.requestJson('/v1/runs', {
      method: 'POST',
      headers: {
        'Idempotency-Key': `agent-lens-${randomUUID()}`,
      },
      body: JSON.stringify({
        input,
        session_id: sessionId,
      }),
    }))
    const runId = textField(response, 'run_id')
    if (!runId) throw new HermesApiError('Hermes run create response has no run_id')
    return runId
  }

  async runState(runId: string): Promise<HermesRunState> {
    const response = asRecord(await this.requestJson(
      `/v1/runs/${encodeURIComponent(runId)}`,
    ))
    const id = textField(response, 'run_id') ?? runId
    const status = textField(response, 'status')
    if (!status) throw new HermesApiError('Hermes run status response has no status')
    const sessionId = textField(response, 'session_id')
    return {
      ...response,
      run_id: id,
      status,
      ...(sessionId ? { session_id: sessionId } : {}),
    }
  }

  async stopRun(runId: string): Promise<Record<string, unknown>> {
    return asRecord(await this.requestJson(
      `/v1/runs/${encodeURIComponent(runId)}/stop`,
      { method: 'POST', body: '{}' },
    ))
  }

  async *runEvents(
    runId: string,
    signal?: AbortSignal,
  ): AsyncIterable<Record<string, unknown>> {
    // Hermes Runs SSE supports Last-Event-ID/last_seq replay. Unlike a plain
    // reconnect, this cursor prevents duplicate deltas and tools.
    let lastSequence = -1
    let attempts = 0
    const path = `/v1/runs/${encodeURIComponent(runId)}/events`
    const streamSignal = signal ?? new AbortController().signal
    while (!streamSignal.aborted) {
      let failure: unknown
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const response = await this.request(path, {
          method: 'GET',
          signal: streamSignal,
          ...(lastSequence >= 0 ? { headers: { 'Last-Event-ID': String(lastSequence) } } : {}),
        })
        if (!response.body) throw new HermesApiError('Hermes run event stream has no response body')
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!signal?.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.search(/\r?\n\r?\n/)
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary)
            const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n'
            buffer = buffer.slice(boundary + separator.length)
            const parsed = this.parseSseFrame(frame)
            if (parsed) {
              if (parsed.event === 'replay.truncated') {
                throw new HermesApiError('Hermes event replay window truncated; refresh native session history')
              }
              const seq = typeof parsed.seq === 'number' && Number.isSafeInteger(parsed.seq)
                ? parsed.seq : undefined
              if (seq === undefined || seq > lastSequence) {
                if (seq !== undefined) lastSequence = seq
                yield parsed
                if (parsed.event === 'run.completed' || parsed.event === 'run.failed'
                  || parsed.event === 'run.cancelled' || parsed.event === 'run.interrupted') return
              }
            }
            boundary = buffer.search(/\r?\n\r?\n/)
          }
        }
        buffer += decoder.decode()
        const tail = this.parseSseFrame(buffer)
        if (tail && !signal?.aborted) {
          const seq = typeof tail.seq === 'number' && Number.isSafeInteger(tail.seq)
            ? tail.seq : undefined
          if (seq === undefined || seq > lastSequence) {
            if (seq !== undefined) lastSequence = seq
            yield tail
            if (tail.event === 'run.completed' || tail.event === 'run.failed'
              || tail.event === 'run.cancelled' || tail.event === 'run.interrupted') return
          }
        }
      } catch (error) {
        failure = error
      } finally {
        reader?.releaseLock()
      }
      if (streamSignal.aborted) return
      attempts += 1
      if (attempts > 3 || (failure instanceof HermesApiError
        && failure.message.includes('replay window truncated'))) {
        if (failure) throw failure
        throw new HermesApiError('Hermes event stream ended without a terminal run event')
      }
      // Avoid a tight reconnect loop on gateway restarts or dropped sockets.
      try {
        await sleep(Math.min(attempts * 250, 1_000), undefined, { signal: streamSignal })
      } catch {
        if (streamSignal.aborted) return
        throw new HermesApiError('Hermes SSE reconnect wait failed')
      }
    }
  }

  private parseSseFrame(frame: string): Record<string, unknown> | null {
    const data = frame
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data) return null
    try {
      return asRecord(JSON.parse(data))
    } catch {
      return { event: 'transport.unparsed', data }
    }
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, init)
    if (response.status === 204) return null
    try {
      return await response.json()
    } catch {
      throw new HermesApiError(`Hermes API returned invalid JSON for ${path}`, response.status)
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.apiKey) {
      throw new HermesApiError(
        'Hermes API key is not configured; enable the Hermes API server and configure API_SERVER_KEY',
      )
    }

    let response: Response
    try {
      response = await fetch(`${this.apiUrl}${path}`, {
        ...init,
        ...(init.signal ? {} : { signal: AbortSignal.timeout(5_000) }),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(init.headers ?? {}),
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new HermesApiError(`Hermes API request failed: ${message}`)
    }

    if (response.ok) return response

    let detail = response.statusText || `HTTP ${response.status}`
    try {
      const payload = asRecord(await response.json())
      const nested = asRecord(payload.error)
      detail = textField(nested, 'message')
        ?? textField(payload, 'message', 'error')
        ?? detail
    } catch {
      // Keep the status text; never include response bodies or credentials in errors.
    }
    throw new HermesApiError(`Hermes API ${response.status}: ${detail}`, response.status)
  }
}
