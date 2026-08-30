import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PiLiveService } from '@agent-lens/runtime-cordis'
import type {
  JsonValue,
  PiLiveAbortRequestDto,
  PiLiveExtensionResponseRequestDto,
  PiLivePromptRequestDto,
  PiLiveSetModelRequestDto,
  PiLiveSetThinkingLevelRequestDto,
  PiLiveStartRequestDto,
} from '@agent-lens/protocol'

const MAX_PI_LIVE_JSON_BYTES = 1024 * 1024
const SSE_HEARTBEAT_MS = 15_000

function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 20) return '[max-depth]'
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1))
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
      result[key] = jsonValue(item, depth + 1)
    }
    return result
  }
  return null
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const content = JSON.stringify(body)
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-length', Buffer.byteLength(content))
  response.end(content)
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const contentType = String(request.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    const error = new Error('Pi Live control requests require application/json') as Error & { statusCode?: number }
    error.statusCode = 415
    throw error
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += chunk.byteLength
    if (size > MAX_PI_LIVE_JSON_BYTES) {
      const error = new Error('Pi Live request body is too large') as Error & { statusCode?: number }
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T
  } catch {
    const error = new Error('Pi Live request body must be valid JSON') as Error & { statusCode?: number }
    error.statusCode = 400
    throw error
  }
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`${name} must be a non-empty string`) as Error & { statusCode?: number }
    error.statusCode = 400
    throw error
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function statusForError(error: unknown): number {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const status = Number((error as { statusCode?: unknown }).statusCode)
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status
  }
  if (error instanceof Error && error.message.startsWith('Unknown Pi Live runtime session:')) return 404
  if (error instanceof Error && /not found/i.test(error.message)) return 503
  return 500
}

function writeError(response: ServerResponse, error: unknown): void {
  const status = statusForError(error)
  writeJson(response, status, {
    error: status === 404 ? 'not_found' : status === 503 ? 'pi_unavailable' : status < 500 ? 'bad_request' : 'internal_error',
    ...(error instanceof Error && status < 500 ? { message: error.message } : {}),
  })
}

async function connectEvents(
  request: IncomingMessage,
  response: ServerResponse,
  service: PiLiveService,
  runtimeSessionId: string,
): Promise<void> {
  await service.state(runtimeSessionId)
  response.statusCode = 200
  response.setHeader('content-type', 'text/event-stream; charset=utf-8')
  response.setHeader('cache-control', 'no-cache, no-transform')
  response.setHeader('connection', 'keep-alive')
  response.setHeader('x-accel-buffering', 'no')
  response.flushHeaders?.()
  response.write(': agent-lens pi-live\n\n')

  const unsubscribe = service.subscribe(runtimeSessionId, value => {
    response.write(`id: ${value.sequence}\n`)
    response.write('event: pi-live\n')
    response.write(`data: ${JSON.stringify(jsonValue(value))}\n\n`)
  })
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), SSE_HEARTBEAT_MS)
  heartbeat.unref?.()
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    clearInterval(heartbeat)
    unsubscribe()
  }
  request.once('close', cleanup)
  response.once('close', cleanup)
}

export async function handlePiLiveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: PiLiveService | undefined,
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/v1/pi-live')) return false
  if (!service) {
    writeJson(response, 503, { error: 'pi_live_unavailable' })
    return true
  }

  try {
    if (url.pathname === '/api/v1/pi-live/availability') {
      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method_not_allowed' })
        return true
      }
      writeJson(response, 200, await service.availability())
      return true
    }

    if (url.pathname === '/api/v1/pi-live') {
      if (request.method === 'GET') {
        writeJson(response, 200, jsonValue(await service.list()))
        return true
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method_not_allowed' })
        return true
      }
      const body = await readJson<PiLiveStartRequestDto>(request)
      const input: PiLiveStartRequestDto = {
        cwd: nonEmpty(body.cwd, 'cwd'),
        ...(optionalString(body.executable) ? { executable: optionalString(body.executable) } : {}),
        ...(optionalString(body.provider) ? { provider: optionalString(body.provider) } : {}),
        ...(optionalString(body.model) ? { model: optionalString(body.model) } : {}),
        ...(optionalString(body.name) ? { name: optionalString(body.name) } : {}),
        ...(optionalString(body.sessionDir) ? { sessionDir: optionalString(body.sessionDir) } : {}),
        ...(optionalString(body.sessionPath) ? { sessionPath: optionalString(body.sessionPath) } : {}),
      }
      writeJson(response, 201, jsonValue(await service.start(input)))
      return true
    }

    const match = url.pathname.match(/^\/api\/v1\/pi-live\/([^/]+)(?:\/(state|snapshot|events|controls|model|thinking-level|prompt|steer|follow-up|abort|extension-response))?$/)
    if (!match) {
      writeJson(response, 404, { error: 'not_found' })
      return true
    }
    const runtimeSessionId = decodeURIComponent(match[1]!)
    const action = match[2]

    if (!action && request.method === 'DELETE') {
      await service.terminate(runtimeSessionId)
      writeJson(response, 200, { ok: true })
      return true
    }
    if (action === 'state' && request.method === 'GET') {
      writeJson(response, 200, jsonValue(await service.state(runtimeSessionId)))
      return true
    }
    if (action === 'snapshot' && request.method === 'GET') {
      const since = optionalString(url.searchParams.get('since'))
      writeJson(response, 200, jsonValue(await service.snapshot(runtimeSessionId, since)))
      return true
    }
    if (action === 'events' && request.method === 'GET') {
      await connectEvents(request, response, service, runtimeSessionId)
      return true
    }
    if (action === 'controls' && request.method === 'GET') {
      writeJson(response, 200, jsonValue(await service.controls(runtimeSessionId)))
      return true
    }
    if (action === 'model' && request.method === 'POST') {
      const body = await readJson<PiLiveSetModelRequestDto>(request)
      const provider = nonEmpty(body.provider, 'provider')
      const modelId = nonEmpty(body.modelId, 'modelId')
      writeJson(response, 200, jsonValue(await service.setModel(runtimeSessionId, provider, modelId)))
      return true
    }
    if (action === 'thinking-level' && request.method === 'POST') {
      const body = await readJson<PiLiveSetThinkingLevelRequestDto>(request)
      writeJson(response, 200, jsonValue(await service.setThinkingLevel(runtimeSessionId, nonEmpty(body.level, 'level'))))
      return true
    }
    if (action === 'prompt' && request.method === 'POST') {
      const body = await readJson<PiLivePromptRequestDto>(request)
      const message = nonEmpty(body.message, 'message')
      if (body.behavior !== undefined && body.behavior !== 'steer' && body.behavior !== 'followUp') {
        const error = new Error('behavior must be steer or followUp') as Error & { statusCode?: number }
        error.statusCode = 400
        throw error
      }
      await service.prompt(runtimeSessionId, message, body.behavior)
      writeJson(response, 202, { ok: true })
      return true
    }
    if (action === 'steer' && request.method === 'POST') {
      const body = await readJson<PiLivePromptRequestDto>(request)
      await service.steer(runtimeSessionId, nonEmpty(body.message, 'message'))
      writeJson(response, 202, { ok: true })
      return true
    }
    if (action === 'follow-up' && request.method === 'POST') {
      const body = await readJson<PiLivePromptRequestDto>(request)
      await service.followUp(runtimeSessionId, nonEmpty(body.message, 'message'))
      writeJson(response, 202, { ok: true })
      return true
    }
    if (action === 'abort' && request.method === 'POST') {
      const body = await readJson<PiLiveAbortRequestDto>(request)
      writeJson(response, 200, await service.abort(runtimeSessionId, { restoreQueue: body.restoreQueue !== false }))
      return true
    }
    if (action === 'extension-response' && request.method === 'POST') {
      const body = await readJson<PiLiveExtensionResponseRequestDto>(request)
      await service.respondToExtension(runtimeSessionId, nonEmpty(body.requestId, 'requestId'), body.response)
      writeJson(response, 202, { ok: true })
      return true
    }

    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  } catch (error) {
    if (!response.headersSent) writeError(response, error)
    else response.destroy(error instanceof Error ? error : new Error(String(error)))
    return true
  }
}
