import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

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

async function apiKeyFromEnvFiles(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      const parsed = parseEnv(await readFile(path, 'utf8'))
      const key = parsed.API_SERVER_KEY?.trim()
      if (key) return key
    } catch {
      // Credential discovery is best effort. Availability reports missing/unreachable API state.
    }
  }
  return undefined
}

export async function resolveHermesApiClientConfig(
  config: HermesApiClientConfig = {},
): Promise<ResolvedHermesApiClientConfig> {
  const port = process.env.HERMES_API_PORT?.trim()
    || process.env.API_SERVER_PORT?.trim()
    || '8642'
  const apiUrl = (config.apiUrl
    ?? process.env.HERMES_API_URL
    ?? `http://127.0.0.1:${port}`)
    .replace(/\/+$/, '')

  let apiKey = config.apiKey?.trim()
    || process.env.HERMES_API_KEY?.trim()
    || process.env.API_SERVER_KEY?.trim()

  if (!apiKey) {
    const envFiles = unique([
      ...(config.envFiles ?? []),
      process.env.HERMES_HOME ? join(process.env.HERMES_HOME, '.env') : undefined,
      join(homedir(), '.hermes', '.env'),
      process.platform === 'win32' && process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'hermes', '.env')
        : undefined,
    ])
    apiKey = await apiKeyFromEnvFiles(envFiles)
  }

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
  private readonly apiUrl: string
  private readonly apiKey?: string

  constructor(config: ResolvedHermesApiClientConfig) {
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

  async sessionMessages(sessionId: string): Promise<unknown[]> {
    const response = asRecord(await this.requestJson(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?order=oldest&limit=500`,
    ))
    return Array.isArray(response.data) ? response.data : []
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
    return {
      ...response,
      run_id: id,
      status,
      ...(textField(response, 'session_id') ? { session_id: textField(response, 'session_id') } : {}),
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
    const response = await this.request(
      `/v1/runs/${encodeURIComponent(runId)}/events`,
      { method: 'GET', ...(signal ? { signal } : {}) },
    )
    if (!response.body) throw new HermesApiError('Hermes run event stream has no response body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let boundary = buffer.search(/\r?\n\r?\n/)
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n'
          buffer = buffer.slice(boundary + separator.length)
          const parsed = this.parseSseFrame(frame)
          if (parsed) yield parsed
          boundary = buffer.search(/\r?\n\r?\n/)
        }
      }

      buffer += decoder.decode()
      const tail = this.parseSseFrame(buffer)
      if (tail) yield tail
    } finally {
      reader.releaseLock()
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
