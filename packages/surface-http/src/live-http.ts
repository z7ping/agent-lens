import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  LiveAdapter,
  LiveCapabilityName,
  LiveService,
  LiveStartCapabilities,
  LiveStartInput,
} from '@agent-lens/core'
import { parseLiveMessageInputDto, type JsonValue } from '@agent-lens/protocol'
import { httpError, readJsonBody, writeJson } from './http-utils'
import { readHostProjectDirectory } from './project-directory-host'

const MAX_LIVE_JSON_BYTES = 1024 * 1024
const SSE_HEARTBEAT_MS = 15_000
const DEFAULT_START_CAPABILITIES: Readonly<LiveStartCapabilities> = {
  workspace: 'unsupported',
  title: 'unsupported',
}
const adapterReadInFlight = new WeakMap<LiveAdapter, Map<string, Promise<unknown>>>()

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

async function readJson(request: IncomingMessage): Promise<unknown> {
  return readJsonBody(request, {
    maxBytes: MAX_LIVE_JSON_BYTES,
    contentTypeMessage: 'Live control requests require application/json',
    invalidJsonMessage: 'Live request body must be valid JSON',
  })
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'Live request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw httpError(400, `${name} must be a non-empty string`)
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function startCapabilities(adapter: LiveAdapter): Readonly<LiveStartCapabilities> {
  return adapter.startCapabilities ?? DEFAULT_START_CAPABILITIES
}

function parseStartInput(adapter: LiveAdapter, value: unknown): LiveStartInput {
  const input = value === undefined ? {} : objectBody(value)
  for (const key of Object.keys(input)) {
    if (key !== 'workspacePath' && key !== 'title') {
      throw httpError(400, `Unsupported Live start field: ${key}`)
    }
  }

  const capabilities = startCapabilities(adapter)
  const hasWorkspace = Object.hasOwn(input, 'workspacePath')
  const hasTitle = Object.hasOwn(input, 'title')
  const workspacePath = optionalString(input.workspacePath)
  const title = optionalString(input.title)

  if (hasWorkspace && !workspacePath) throw httpError(400, 'workspacePath must be a non-empty string')
  if (hasTitle && !title) throw httpError(400, 'title must be a non-empty string')
  if (workspacePath && capabilities.workspace === 'unsupported') {
    throw httpError(409, `${adapter.manifest.displayName} does not support per-task workspace selection`)
  }
  if (title && capabilities.title === 'unsupported') {
    throw httpError(409, `${adapter.manifest.displayName} does not support task titles`)
  }
  if (capabilities.workspace === 'required' && !workspacePath) {
    throw httpError(400, 'workspacePath is required for this Live adapter')
  }
  if (capabilities.title === 'required' && !title) {
    throw httpError(400, 'title is required for this Live adapter')
  }

  return {
    ...(workspacePath ? { workspacePath } : {}),
    ...(title ? { title } : {}),
  }
}

function statusForError(error: unknown): number {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const status = Number((error as { statusCode?: unknown }).statusCode)
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status
  }
  if (error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'live_interaction_unavailable') return 409
  const message = error instanceof Error ? error.message : String(error)
  if (/unknown .*runtime|runtime .*not found|unknown .*session|session .*not found/i.test(message)) return 404
  return 500
}

function writeError(response: ServerResponse, error: unknown): void {
  const status = statusForError(error)
  writeJson(response, status, {
    error: status === 404
      ? 'not_found'
      : status === 409
        ? 'capability_unavailable'
        : status < 500
          ? 'bad_request'
          : 'internal_error',
    ...(error instanceof Error && status < 500 ? { message: error.message } : {}),
  })
}

function adapterFor(service: LiveService, liveId: string): LiveAdapter {
  const adapter = service.get(liveId)
  if (!adapter) throw httpError(404, `Unknown Live adapter: ${liveId}`)
  return adapter
}

function requireCapability(adapter: LiveAdapter, capability: LiveCapabilityName): void {
  if (!adapter.capabilities.has(capability)) {
    throw httpError(409, `${adapter.manifest.displayName} does not support Live capability: ${capability}`)
  }
}

function liveDescriptor(adapter: LiveAdapter, availability: unknown, runtimes: unknown): JsonValue {
  return jsonValue({
    liveId: adapter.manifest.liveId,
    productId: adapter.manifest.productId,
    displayName: adapter.manifest.displayName,
    capabilities: [...adapter.capabilities],
    inputCapabilities: adapter.inputCapabilities,
    startCapabilities: startCapabilities(adapter),
    availability,
    runtimes,
  })
}

function shareAdapterRead<T>(
  adapter: LiveAdapter,
  key: string,
  start: () => Promise<T>,
): Promise<T> {
  let reads = adapterReadInFlight.get(adapter)
  if (!reads) {
    reads = new Map()
    adapterReadInFlight.set(adapter, reads)
  }
  const existing = reads.get(key)
  if (existing) return existing as Promise<T>

  let pending!: Promise<T>
  pending = start().finally(() => {
    if (reads!.get(key) === pending) reads!.delete(key)
  })
  reads.set(key, pending)
  return pending
}

async function describeAdapter(adapter: LiveAdapter): Promise<JsonValue> {
  return shareAdapterRead(adapter, 'descriptor', async () => {
    const [availabilityResult, runtimesResult] = await Promise.allSettled([
      shareAdapterRead(adapter, 'availability', () => adapter.availability()),
      shareAdapterRead(adapter, 'runtimes', () => adapter.list()),
    ])
    const availability = availabilityResult.status === 'fulfilled'
      ? availabilityResult.value
      : {
          available: false,
          reason: availabilityResult.reason instanceof Error
            ? availabilityResult.reason.message
            : String(availabilityResult.reason),
        }
    const runtimes = runtimesResult.status === 'fulfilled' ? runtimesResult.value : []
    return liveDescriptor(adapter, availability, runtimes)
  })
}

function sendBehavior(value: unknown): 'normal' | 'steer' | 'follow-up' | undefined {
  if (value === undefined) return undefined
  if (value === 'normal' || value === 'steer' || value === 'follow-up') return value
  throw httpError(400, 'behavior must be normal, steer, or follow-up')
}

async function connectEvents(
  request: IncomingMessage,
  response: ServerResponse,
  adapter: LiveAdapter,
  runtimeSessionId: string,
): Promise<void> {
  requireCapability(adapter, 'stream')
  await shareAdapterRead(adapter, `state:${runtimeSessionId}`, () => adapter.state(runtimeSessionId))
  response.statusCode = 200
  response.setHeader('content-type', 'text/event-stream; charset=utf-8')
  response.setHeader('cache-control', 'no-cache, no-transform')
  response.setHeader('connection', 'keep-alive')
  response.setHeader('x-accel-buffering', 'no')
  response.flushHeaders?.()
  response.write(': agent-lens live\n\n')

  const unsubscribe = adapter.subscribe(runtimeSessionId, value => {
    response.write(`id: ${value.sequence}\n`)
    response.write('event: live\n')
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

export async function handleLiveRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: LiveService | undefined,
  selectProjectDirectory?: () => Promise<string | undefined>,
): Promise<boolean> {
  if (url.pathname !== '/api/v1/live' && !url.pathname.startsWith('/api/v1/live/')) return false
  if (url.pathname === '/api/v1/live/attachments' || url.pathname.startsWith('/api/v1/live/attachments/')) return false

  try {
    if (url.pathname === '/api/v1/live/project-directory') {
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method_not_allowed' })
        return true
      }
      const hostSelection = readHostProjectDirectory(request)
      if (hostSelection.handled) {
        writeJson(response, 200, { workspacePath: hostSelection.cwd ?? null })
        return true
      }
      if (!selectProjectDirectory) throw httpError(501, '当前运行时不支持选择项目目录')
      const workspacePath = await selectProjectDirectory()
      writeJson(response, 200, { workspacePath: workspacePath ?? null })
      return true
    }

    if (!service) {
      writeJson(response, 503, { error: 'live_unavailable' })
      return true
    }

    if (url.pathname === '/api/v1/live') {
      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method_not_allowed' })
        return true
      }
      const items = await Promise.all(service.list().map(describeAdapter))
      writeJson(response, 200, { items })
      return true
    }

    const historyMatch = url.pathname.match(/^\/api\/v1\/live\/([^/]+)\/history\/([^/]+)\/(resume|fork)$/)
    if (historyMatch) {
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'method_not_allowed' })
        return true
      }
      const liveId = decodeURIComponent(historyMatch[1]!)
      const logicalSessionId = decodeURIComponent(historyMatch[2]!)
      const action = historyMatch[3] as 'resume' | 'fork'
      const adapter = adapterFor(service, liveId)
      requireCapability(adapter, action)
      const handler = action === 'resume' ? adapter.resume : adapter.fork
      if (!handler) throw httpError(409, `${adapter.manifest.displayName} does not expose Live ${action}`)
      writeJson(response, 201, jsonValue(await handler.call(adapter, logicalSessionId)))
      return true
    }

    const adapterMatch = url.pathname.match(/^\/api\/v1\/live\/([^/]+)(?:\/(availability|runtimes))?$/)
    if (adapterMatch) {
      const liveId = decodeURIComponent(adapterMatch[1]!)
      const action = adapterMatch[2]
      const adapter = adapterFor(service, liveId)

      if (!action && request.method === 'GET') {
        writeJson(response, 200, await describeAdapter(adapter))
        return true
      }
      if (action === 'availability' && request.method === 'GET') {
        writeJson(response, 200, jsonValue(await shareAdapterRead(adapter, 'availability', () => adapter.availability())))
        return true
      }
      if (action === 'runtimes' && request.method === 'GET') {
        writeJson(response, 200, jsonValue(await shareAdapterRead(adapter, 'runtimes', () => adapter.list())))
        return true
      }
      if (action === 'runtimes' && request.method === 'POST') {
        requireCapability(adapter, 'create')
        const body = objectBody(await readJson(request))
        const input = parseStartInput(adapter, Object.hasOwn(body, 'input') ? body.input : {})
        writeJson(response, 201, jsonValue(await adapter.start(input)))
        return true
      }
      writeJson(response, 405, { error: 'method_not_allowed' })
      return true
    }

    const runtimeMatch = url.pathname.match(/^\/api\/v1\/live\/([^/]+)\/runtimes\/([^/]+)(?:\/(state|snapshot|events|messages|commands|message-actions|queue|interrupt|model-control|thinking-control|extension-response))?$/)
    if (!runtimeMatch) {
      writeJson(response, 404, { error: 'not_found' })
      return true
    }

    const liveId = decodeURIComponent(runtimeMatch[1]!)
    const runtimeSessionId = decodeURIComponent(runtimeMatch[2]!)
    const action = runtimeMatch[3]
    const adapter = adapterFor(service, liveId)

    if (!action && request.method === 'GET') {
      writeJson(response, 200, jsonValue(await shareAdapterRead(
        adapter,
        `state:${runtimeSessionId}`,
        () => adapter.state(runtimeSessionId),
      )))
      return true
    }
    if (!action && request.method === 'DELETE') {
      await adapter.terminate(runtimeSessionId)
      writeJson(response, 200, { ok: true })
      return true
    }
    if (action === 'state' && request.method === 'GET') {
      writeJson(response, 200, jsonValue(await shareAdapterRead(
        adapter,
        `state:${runtimeSessionId}`,
        () => adapter.state(runtimeSessionId),
      )))
      return true
    }
    if (action === 'snapshot' && request.method === 'GET') {
      const since = optionalString(url.searchParams.get('since'))
      writeJson(response, 200, jsonValue(await shareAdapterRead(
        adapter,
        `snapshot:${runtimeSessionId}:${since ?? ''}`,
        () => adapter.snapshot(runtimeSessionId, since),
      )))
      return true
    }
    if (action === 'events' && request.method === 'GET') {
      await connectEvents(request, response, adapter, runtimeSessionId)
      return true
    }
    if (action === 'messages' && request.method === 'POST') {
      requireCapability(adapter, 'send')
      const body = objectBody(await readJson(request))
      if (!Object.hasOwn(body, 'message')) throw httpError(400, 'message is required')
      const behavior = sendBehavior(body.behavior)
      if (behavior === 'steer') requireCapability(adapter, 'steer')
      if (behavior === 'follow-up') requireCapability(adapter, 'queue')
      let message
      try {
        message = parseLiveMessageInputDto(body.message)
      } catch (error) {
        throw httpError(400, error instanceof Error ? error.message : 'Invalid Live message')
      }
      await adapter.send(runtimeSessionId, message, behavior ? { behavior } : undefined)
      writeJson(response, 202, { ok: true })
      return true
    }
    if (action === 'commands' && request.method === 'GET') {
      requireCapability(adapter, 'command-discovery')
      if (!adapter.commands) throw httpError(409, `${adapter.manifest.displayName} does not expose Live command discovery`)
      writeJson(response, 200, {
        items: jsonValue(await shareAdapterRead(
          adapter,
          `commands:${runtimeSessionId}`,
          () => adapter.commands!(runtimeSessionId),
        )),
      })
      return true
    }

    if (action === 'message-actions' && request.method === 'GET') {
      writeJson(response, 200, {
        items: jsonValue(adapter.messageActions
          ? await shareAdapterRead(
              adapter,
              `message-actions:${runtimeSessionId}`,
              () => adapter.messageActions!(runtimeSessionId),
            )
          : []),
      })
      return true
    }
    if (action === 'message-actions' && request.method === 'POST') {
      if (!adapter.executeMessageAction) {
        throw httpError(409, `${adapter.manifest.displayName} does not expose Live message actions`)
      }
      const body = objectBody(await readJson(request))
      const actionId = optionalString(body.actionId)
      const targetEntryId = optionalString(body.targetEntryId)
      if (!actionId || !targetEntryId) throw httpError(400, 'actionId and targetEntryId are required')
      if (actionId.length > 128) throw httpError(400, 'actionId is too long')
      if (targetEntryId.length > 512) throw httpError(400, 'targetEntryId is too long')
      if (!adapter.messageActions) {
        throw httpError(409, `${adapter.manifest.displayName} has not declared Live message actions`)
      }
      const declared = await adapter.messageActions(runtimeSessionId)
      if (!declared.some(action => action.actionId === actionId)) {
        throw httpError(409, 'Live message action is not currently declared by this adapter')
      }
      writeJson(response, 200, jsonValue(await adapter.executeMessageAction(
        runtimeSessionId,
        actionId,
        targetEntryId,
      )))
      return true
    }
    if (action === 'queue' && request.method === 'GET') {
      requireCapability(adapter, 'queue')
      if (!adapter.queueState) throw httpError(409, `${adapter.manifest.displayName} does not expose Live queue state`)
      writeJson(response, 200, jsonValue(await shareAdapterRead(
        adapter,
        `queue:${runtimeSessionId}`,
        () => adapter.queueState!(runtimeSessionId),
      )))
      return true
    }
    if (action === 'queue' && request.method === 'DELETE') {
      requireCapability(adapter, 'queue')
      if (!adapter.clearQueue) throw httpError(409, `${adapter.manifest.displayName} does not expose Live queue control`)
      writeJson(response, 200, jsonValue(await adapter.clearQueue(runtimeSessionId)))
      return true
    }
    if (action === 'interrupt' && request.method === 'POST') {
      requireCapability(adapter, 'interrupt')
      if (!adapter.interrupt) throw httpError(409, `${adapter.manifest.displayName} does not expose Live interrupt`)
      writeJson(response, 200, jsonValue(await adapter.interrupt(runtimeSessionId)))
      return true
    }
    if (action === 'model-control' && request.method === 'GET') {
      requireCapability(adapter, 'model-switching')
      if (!adapter.modelControl) throw httpError(409, `${adapter.manifest.displayName} does not expose model control`)
      writeJson(response, 200, jsonValue(await shareAdapterRead(
        adapter,
        `model-control:${runtimeSessionId}`,
        () => adapter.modelControl!(runtimeSessionId),
      )))
      return true
    }
    if (action === 'model-control' && request.method === 'POST') {
      requireCapability(adapter, 'model-switching')
      if (!adapter.setModelControl) throw httpError(409, `${adapter.manifest.displayName} does not expose model control`)
      const body = objectBody(await readJson(request))
      writeJson(response, 200, jsonValue(await adapter.setModelControl(runtimeSessionId, nonEmpty(body.value, 'value'))))
      return true
    }
    if (action === 'thinking-control' && request.method === 'GET') {
      requireCapability(adapter, 'thinking-control')
      if (!adapter.thinkingControl) throw httpError(409, `${adapter.manifest.displayName} does not expose thinking control`)
      writeJson(response, 200, jsonValue(await shareAdapterRead(
        adapter,
        `thinking-control:${runtimeSessionId}`,
        () => adapter.thinkingControl!(runtimeSessionId),
      )))
      return true
    }
    if (action === 'thinking-control' && request.method === 'POST') {
      requireCapability(adapter, 'thinking-control')
      if (!adapter.setThinkingControl) throw httpError(409, `${adapter.manifest.displayName} does not expose thinking control`)
      const body = objectBody(await readJson(request))
      writeJson(response, 200, jsonValue(await adapter.setThinkingControl(runtimeSessionId, nonEmpty(body.value, 'value'))))
      return true
    }
    if (action === 'extension-response' && request.method === 'POST') {
      requireCapability(adapter, 'extension-ui')
      if (!adapter.respondToExtension) throw httpError(409, `${adapter.manifest.displayName} does not expose extension UI responses`)
      const body = objectBody(await readJson(request))
      if (!Object.hasOwn(body, 'response')) throw httpError(400, 'response is required')
      await adapter.respondToExtension(runtimeSessionId, nonEmpty(body.requestId, 'requestId'), body.response)
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
