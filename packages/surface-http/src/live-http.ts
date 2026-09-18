import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  LIVE_HISTORY_INDEX_MAX_LIMIT,
  LIVE_SNAPSHOT_DEFAULT_LIMIT,
  LIVE_SNAPSHOT_MAX_LIMIT,
} from '@agent-lens/core'
import type {
  LiveAdapter,
  LiveCapabilityName,
  LiveContributionText,
  LiveContributionValue,
  LiveMessageActionContribution,
  LiveMessageActionResult,
  LiveRuntimeActionContribution,
  LiveRuntimeActionResult,
  LiveRuntimeContributionField,
  LiveRuntimeDisclosureContribution,
  LiveRuntimeState,
  LiveSnapshot,
  LiveService,
  LiveSnapshotWindow,
  LiveStartCapabilities,
  LiveStartInput,
} from '@agent-lens/core'
import { parseLiveMessageInputDto, type JsonValue } from '@agent-lens/protocol'
import { httpError, readJsonBody, writeJson } from './http-utils'
import { readHostProjectDirectory } from './project-directory-host'

const MAX_LIVE_JSON_BYTES = 1024 * 1024
const MAX_LIVE_MESSAGE_ACTIONS = 16
const MAX_LIVE_MESSAGE_ACTION_ID = 128
const MAX_LIVE_CONTRIBUTION_LABEL = 120
const MAX_LIVE_CONTRIBUTION_DESCRIPTION = 600
const MAX_LIVE_RUNTIME_DISCLOSURES = 8
const MAX_LIVE_RUNTIME_FIELDS = 40
const MAX_LIVE_RUNTIME_ACTIONS = 16
const MAX_LIVE_CONTRIBUTION_VALUES = 80
const MAX_LIVE_CONTRIBUTION_VALUE = 4_000
const SSE_HEARTBEAT_MS = 15_000
const DEFAULT_START_CAPABILITIES: Readonly<LiveStartCapabilities> = {
  workspace: 'unsupported',
  title: 'unsupported',
}
const adapterReadInFlight = new WeakMap<LiveAdapter, Map<string, Promise<unknown>>>()
const LIVE_RUNTIME_VALIDATION_TTL_MS = 2_000
const validatedRuntimeAt = new WeakMap<LiveAdapter, Map<string, number>>()

function markRuntimeValidated(adapter: LiveAdapter, runtimeSessionId: string): void {
  let values = validatedRuntimeAt.get(adapter)
  if (!values) {
    values = new Map()
    validatedRuntimeAt.set(adapter, values)
  }
  values.set(runtimeSessionId, Date.now())
}

function runtimeRecentlyValidated(adapter: LiveAdapter, runtimeSessionId: string): boolean {
  const at = validatedRuntimeAt.get(adapter)?.get(runtimeSessionId)
  return at !== undefined && Date.now() - at < LIVE_RUNTIME_VALIDATION_TTL_MS
}


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

function contributionText(value: unknown, maxLength: number): LiveContributionText | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const defaultText = typeof row.default === 'string' ? row.default.trim() : ''
  if (!defaultText) return null

  const localizations: Record<string, string> = {}
  if (row.localizations && typeof row.localizations === 'object' && !Array.isArray(row.localizations)) {
    for (const [rawLocale, rawText] of Object.entries(row.localizations as Record<string, unknown>)) {
      const locale = rawLocale.trim()
      if (!locale || locale.length > 32 || typeof rawText !== 'string' || !rawText.trim()) continue
      localizations[locale] = rawText.trim().slice(0, maxLength)
      if (Object.keys(localizations).length >= 8) break
    }
  }

  return {
    default: defaultText.slice(0, maxLength),
    ...(Object.keys(localizations).length ? { localizations } : {}),
  }
}


function contributionValue(value: unknown): LiveContributionValue | null {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, MAX_LIVE_CONTRIBUTION_VALUE)
  return contributionText(value, MAX_LIVE_CONTRIBUTION_VALUE)
}

function normalizeRuntimeDisclosures(value: unknown): LiveRuntimeDisclosureContribution[] {
  if (!Array.isArray(value)) return []
  const result: LiveRuntimeDisclosureContribution[] = []
  const contributionIds = new Set<string>()
  const actionIds = new Set<string>()
  let actionCount = 0

  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const row = candidate as Record<string, unknown>
    const contributionId = typeof row.contributionId === 'string' ? row.contributionId : ''
    if (!contributionId
      || contributionId !== contributionId.trim()
      || contributionId.length > 128
      || contributionIds.has(contributionId)) continue

    const title = contributionText(row.title, MAX_LIVE_CONTRIBUTION_LABEL)
    if (!title || !Array.isArray(row.fields)) continue
    const summary = row.summary === undefined
      ? undefined
      : contributionText(row.summary, MAX_LIVE_CONTRIBUTION_DESCRIPTION)
    if (row.summary !== undefined && !summary) continue

    const tone = row.tone
    if (tone !== undefined
      && tone !== 'neutral'
      && tone !== 'info'
      && tone !== 'warning'
      && tone !== 'danger') continue
    if (row.defaultExpanded !== undefined && typeof row.defaultExpanded !== 'boolean') continue

    const fields: LiveRuntimeContributionField[] = []
    for (const fieldCandidate of row.fields) {
      if (!fieldCandidate || typeof fieldCandidate !== 'object' || Array.isArray(fieldCandidate)) continue
      const field = fieldCandidate as Record<string, unknown>
      const label = contributionText(field.label, MAX_LIVE_CONTRIBUTION_LABEL)
      if (!label) continue
      const kind = field.kind
      if (kind !== undefined && kind !== 'text' && kind !== 'list' && kind !== 'code') continue
      const normalizedValue = field.value === undefined ? undefined : contributionValue(field.value)
      const normalizedValues = Array.isArray(field.values)
        ? field.values
            .slice(0, MAX_LIVE_CONTRIBUTION_VALUES)
            .map(contributionValue)
            .filter((item): item is LiveContributionValue => item !== null)
        : undefined
      if (field.value !== undefined && normalizedValue === null) continue
      if (!normalizedValue && !normalizedValues?.length) continue
      fields.push({
        label,
        ...(kind ? { kind } : {}),
        ...(normalizedValue ? { value: normalizedValue } : {}),
        ...(normalizedValues?.length ? { values: normalizedValues } : {}),
      })
      if (fields.length >= MAX_LIVE_RUNTIME_FIELDS) break
    }

    const actions: LiveRuntimeActionContribution[] = []
    if (Array.isArray(row.actions)) {
      for (const actionCandidate of row.actions) {
        if (actionCount >= MAX_LIVE_RUNTIME_ACTIONS) break
        if (!actionCandidate || typeof actionCandidate !== 'object' || Array.isArray(actionCandidate)) continue
        const action = actionCandidate as Record<string, unknown>
        const actionId = typeof action.actionId === 'string' ? action.actionId : ''
        if (!actionId
          || actionId !== actionId.trim()
          || actionId.length > MAX_LIVE_MESSAGE_ACTION_ID
          || actionIds.has(actionId)) continue
        const label = contributionText(action.label, MAX_LIVE_CONTRIBUTION_LABEL)
        if (!label) continue
        const description = action.description === undefined
          ? undefined
          : contributionText(action.description, MAX_LIVE_CONTRIBUTION_DESCRIPTION)
        if (action.description !== undefined && !description) continue
        const actionTone = action.tone
        if (actionTone !== undefined
          && actionTone !== 'default'
          && actionTone !== 'primary'
          && actionTone !== 'danger') continue
        actionIds.add(actionId)
        actionCount += 1
        actions.push({
          actionId,
          label,
          ...(description ? { description } : {}),
          ...(actionTone ? { tone: actionTone } : {}),
        })
      }
    }

    contributionIds.add(contributionId)
    result.push({
      contributionId,
      title,
      ...(summary ? { summary } : {}),
      ...(tone ? { tone } : {}),
      ...(typeof row.defaultExpanded === 'boolean' ? { defaultExpanded: row.defaultExpanded } : {}),
      fields,
      ...(actions.length ? { actions } : {}),
    })
    if (result.length >= MAX_LIVE_RUNTIME_DISCLOSURES) break
  }
  return result
}

function normalizeMessageActions(value: unknown): LiveMessageActionContribution[] {
  if (!Array.isArray(value)) return []
  const result: LiveMessageActionContribution[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const row = candidate as Record<string, unknown>
    const actionId = typeof row.actionId === 'string' ? row.actionId : ''
    if (!actionId || actionId !== actionId.trim() || actionId.length > MAX_LIVE_MESSAGE_ACTION_ID || seen.has(actionId)) continue
    const label = contributionText(row.label, MAX_LIVE_CONTRIBUTION_LABEL)
    if (!label || !Array.isArray(row.roles)) continue
    const roles = [...new Set(row.roles.filter((role): role is 'user' | 'assistant' => role === 'user' || role === 'assistant'))]
    if (!roles.length) continue
    if (row.requiresIdle !== undefined && typeof row.requiresIdle !== 'boolean') continue
    const description = row.description === undefined
      ? undefined
      : contributionText(row.description, MAX_LIVE_CONTRIBUTION_DESCRIPTION)
    if (row.description !== undefined && !description) continue
    seen.add(actionId)
    result.push({
      actionId,
      label,
      ...(description ? { description } : {}),
      roles,
      ...(typeof row.requiresIdle === 'boolean' ? { requiresIdle: row.requiresIdle } : {}),
    })
    if (result.length >= MAX_LIVE_MESSAGE_ACTIONS) break
  }
  return result
}

function normalizePublicRuntimeState(value: unknown): LiveRuntimeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(500, 'Live adapter returned an invalid runtime')
  }
  const row = value as Record<string, unknown>
  const runtimeSessionId = typeof row.runtimeSessionId === 'string' ? row.runtimeSessionId.trim() : ''
  const status = row.status
  if (!runtimeSessionId || runtimeSessionId.length > 512) {
    throw httpError(500, 'Live adapter returned an invalid runtime identity')
  }
  if (status !== 'initializing'
    && status !== 'ready'
    && status !== 'failed'
    && status !== 'terminating'
    && status !== 'terminated') {
    throw httpError(500, 'Live adapter returned an invalid runtime status')
  }
  if (typeof row.isStreaming !== 'boolean'
    || typeof row.pendingMessageCount !== 'number'
    || !Number.isSafeInteger(row.pendingMessageCount)
    || row.pendingMessageCount < 0) {
    throw httpError(500, 'Live adapter returned an invalid runtime state')
  }
  const title = typeof row.title === 'string' && row.title.trim()
    ? row.title.trim().slice(0, 240)
    : undefined
  const nativeSessionId = typeof row.nativeSessionId === 'string' && row.nativeSessionId.trim()
    ? row.nativeSessionId.trim().slice(0, 512)
    : undefined
  const workspacePath = typeof row.workspacePath === 'string' && row.workspacePath.trim()
    ? row.workspacePath.trim().slice(0, 4096)
    : undefined
  return {
    runtimeSessionId,
    ...(title ? { title } : {}),
    status,
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(workspacePath ? { workspacePath } : {}),
    isStreaming: row.isStreaming,
    pendingMessageCount: row.pendingMessageCount,
  }
}

function normalizeMessageActionResult(value: unknown): LiveMessageActionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(500, 'Live message action returned an invalid result')
  }
  const row = value as Record<string, unknown>
  if (row.outcome !== 'refresh-current' && row.outcome !== 'open-runtime') {
    throw httpError(500, 'Live message action returned an invalid outcome')
  }
  const runtime = row.outcome === 'open-runtime'
    ? normalizePublicRuntimeState(row.runtime)
    : undefined
  if (row.draftText !== undefined && typeof row.draftText !== 'string') {
    throw httpError(500, 'Live message action returned invalid draftText')
  }
  return {
    outcome: row.outcome,
    ...(runtime ? { runtime } : {}),
    ...(typeof row.draftText === 'string' ? { draftText: row.draftText } : {}),
  }
}


function normalizePublicSnapshot(value: unknown): LiveSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(500, 'Live adapter returned an invalid snapshot')
  }
  const row = value as Record<string, unknown>
  if (!Array.isArray(row.entries)) throw httpError(500, 'Live adapter snapshot entries must be an array')
  const leafId = row.leafId
  if (leafId !== undefined && leafId !== null && typeof leafId !== 'string') {
    throw httpError(500, 'Live adapter returned an invalid snapshot leaf id')
  }
  const rawPage = row.page
  let page: LiveSnapshot['page']
  if (rawPage !== undefined) {
    if (!rawPage || typeof rawPage !== 'object' || Array.isArray(rawPage)) {
      throw httpError(500, 'Live adapter returned invalid snapshot page metadata')
    }
    const value = rawPage as Record<string, unknown>
    if (typeof value.hasEarlier !== 'boolean') {
      throw httpError(500, 'Live adapter snapshot page must declare hasEarlier')
    }
    if (value.before !== undefined && typeof value.before !== 'string') {
      throw httpError(500, 'Live adapter snapshot before cursor is invalid')
    }
    if (value.first !== undefined && typeof value.first !== 'string') {
      throw httpError(500, 'Live adapter snapshot first cursor is invalid')
    }
    if (value.last !== undefined && typeof value.last !== 'string') {
      throw httpError(500, 'Live adapter snapshot last cursor is invalid')
    }
    if (value.hasLater !== undefined && typeof value.hasLater !== 'boolean') {
      throw httpError(500, 'Live adapter snapshot hasLater is invalid')
    }
    if (value.after !== undefined && typeof value.after !== 'string') {
      throw httpError(500, 'Live adapter snapshot after cursor is invalid')
    }
    page = {
      hasEarlier: value.hasEarlier,
      ...(typeof value.before === 'string' ? { before: value.before } : {}),
      ...(typeof value.first === 'string' ? { first: value.first } : {}),
      ...(typeof value.last === 'string' ? { last: value.last } : {}),
      ...(typeof value.hasLater === 'boolean' ? { hasLater: value.hasLater } : {}),
      ...(typeof value.after === 'string' ? { after: value.after } : {}),
    }
  }
  return {
    state: normalizePublicRuntimeState(row.state),
    entries: row.entries,
    ...(leafId !== undefined ? { leafId: leafId as string | null } : {}),
    ...(page ? { page } : {}),
  }
}

function normalizeHistoryIndex(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(500, 'Live adapter returned an invalid history index')
  }
  const row = value as Record<string, unknown>
  if (!Number.isSafeInteger(row.total) || Number(row.total) < 0 || !Array.isArray(row.items)) {
    throw httpError(500, 'Live adapter returned invalid history index metadata')
  }
  if (row.items.length > LIVE_HISTORY_INDEX_MAX_LIMIT) {
    throw httpError(500, 'Live adapter history index exceeded the bounded limit')
  }
  const items = row.items.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw httpError(500, 'Live adapter history index item is invalid')
    }
    const item = raw as Record<string, unknown>
    if (typeof item.cursor !== 'string' || !item.cursor
      || !Number.isSafeInteger(item.ordinal) || Number(item.ordinal) < 1) {
      throw httpError(500, 'Live adapter history index cursor is invalid')
    }
    if (item.preview !== undefined && typeof item.preview !== 'string') {
      throw httpError(500, 'Live adapter history index preview is invalid')
    }
    return {
      cursor: item.cursor,
      ordinal: Number(item.ordinal),
      ...(typeof item.preview === 'string' ? { preview: item.preview.slice(0, 120) } : {}),
    }
  })
  return { total: Number(row.total), items }
}

function normalizeRuntimeActionResult(value: unknown): LiveRuntimeActionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(500, 'Live runtime action returned an invalid result')
  }
  const row = value as Record<string, unknown>
  return { runtime: normalizePublicRuntimeState(row.runtime) }
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

function liveMetadata(adapter: LiveAdapter): JsonValue {
  return jsonValue({
    liveId: adapter.manifest.liveId,
    productId: adapter.manifest.productId,
    displayName: adapter.manifest.displayName,
    capabilities: [...adapter.capabilities],
    inputCapabilities: adapter.inputCapabilities,
    startCapabilities: startCapabilities(adapter),
  })
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
    runtimes: Array.isArray(runtimes) ? runtimes.map(normalizePublicRuntimeState) : [],
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

async function describeProduct(adapter: LiveAdapter): Promise<JsonValue> {
  const availabilityResult = await Promise.resolve(
    shareAdapterRead(adapter, 'availability', () => adapter.availability()),
  ).then(
    value => ({ ok: true as const, value }),
    reason => ({ ok: false as const, reason }),
  )
  const availability = availabilityResult.ok
    ? availabilityResult.value
    : {
        available: false,
        reason: availabilityResult.reason instanceof Error
          ? availabilityResult.reason.message
          : String(availabilityResult.reason),
      }
  return liveDescriptor(adapter, availability, [])
}

async function listKnownRuntimes(service: LiveService): Promise<JsonValue> {
  const groups = await Promise.all(service.list().map(async adapter => {
    try {
      const runtimes = await shareAdapterRead(adapter, 'runtimes', () => adapter.list())
      return runtimes.map(state => ({
        liveId: adapter.manifest.liveId,
        productId: adapter.manifest.productId,
        displayName: adapter.manifest.displayName,
        state: normalizePublicRuntimeState(state),
      }))
    } catch {
      return []
    }
  }))
  return jsonValue({ items: groups.flat() })
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
  if (!runtimeRecentlyValidated(adapter, runtimeSessionId)) {
    await shareAdapterRead(adapter, `state:${runtimeSessionId}`, () => adapter.state(runtimeSessionId))
    markRuntimeValidated(adapter, runtimeSessionId)
  }
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

    if (url.pathname === '/api/v1/live/products') {
      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method_not_allowed' })
        return true
      }
      const items = await Promise.all(service.list().map(describeProduct))
      writeJson(response, 200, { items })
      return true
    }

    if (url.pathname === '/api/v1/live/product-metadata') {
      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method_not_allowed' })
        return true
      }
      const productId = optionalString(url.searchParams.get('productId'))
      if (!productId) throw httpError(400, 'productId is required')
      const items = service.list()
        .filter(adapter => adapter.manifest.productId === productId)
        .map(adapter => liveMetadata(adapter))
      writeJson(response, 200, { items })
      return true
    }

    if (url.pathname === '/api/v1/live/runtimes') {
      if (request.method !== 'GET') {
        writeJson(response, 405, { error: 'method_not_allowed' })
        return true
      }
      writeJson(response, 200, await listKnownRuntimes(service))
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
      writeJson(response, 201, jsonValue(normalizePublicRuntimeState(await handler.call(adapter, logicalSessionId))))
      return true
    }

    const adapterMatch = url.pathname.match(/^\/api\/v1\/live\/([^/]+)(?:\/(metadata|availability|runtimes))?$/)
    if (adapterMatch) {
      const liveId = decodeURIComponent(adapterMatch[1]!)
      const action = adapterMatch[2]
      const adapter = adapterFor(service, liveId)

      if (!action && request.method === 'GET') {
        writeJson(response, 200, await describeAdapter(adapter))
        return true
      }
      if (action === 'metadata' && request.method === 'GET') {
        writeJson(response, 200, liveMetadata(adapter))
        return true
      }
      if (action === 'availability' && request.method === 'GET') {
        writeJson(response, 200, jsonValue(await shareAdapterRead(adapter, 'availability', () => adapter.availability())))
        return true
      }
      if (action === 'runtimes' && request.method === 'GET') {
        writeJson(response, 200, jsonValue(
          (await shareAdapterRead(adapter, 'runtimes', () => adapter.list())).map(normalizePublicRuntimeState),
        ))
        return true
      }
      if (action === 'runtimes' && request.method === 'POST') {
        requireCapability(adapter, 'create')
        const body = objectBody(await readJson(request))
        const input = parseStartInput(adapter, Object.hasOwn(body, 'input') ? body.input : {})
        writeJson(response, 201, jsonValue(normalizePublicRuntimeState(await adapter.start(input))))
        return true
      }
      writeJson(response, 405, { error: 'method_not_allowed' })
      return true
    }

    const runtimeMatch = url.pathname.match(/^\/api\/v1\/live\/([^/]+)\/runtimes\/([^/]+)(?:\/(state|snapshot|events|messages|commands|workspace-references|message-actions|runtime-disclosures|runtime-actions|queue|interrupt|model-control|thinking-control|extension-response))?$/)
    if (!runtimeMatch) {
      writeJson(response, 404, { error: 'not_found' })
      return true
    }

    const liveId = decodeURIComponent(runtimeMatch[1]!)
    const runtimeSessionId = decodeURIComponent(runtimeMatch[2]!)
    const action = runtimeMatch[3]
    const adapter = adapterFor(service, liveId)

    if (!action && request.method === 'GET') {
      writeJson(response, 200, jsonValue(normalizePublicRuntimeState(await shareAdapterRead(
        adapter,
        `state:${runtimeSessionId}`,
        () => adapter.state(runtimeSessionId),
      ))))
      return true
    }
    if (!action && request.method === 'DELETE') {
      await adapter.terminate(runtimeSessionId)
      writeJson(response, 200, { ok: true })
      return true
    }
    if (action === 'state' && request.method === 'GET') {
      const state = normalizePublicRuntimeState(await shareAdapterRead(
        adapter,
        `state:${runtimeSessionId}`,
        () => adapter.state(runtimeSessionId),
      ))
      markRuntimeValidated(adapter, runtimeSessionId)
      writeJson(response, 200, jsonValue(state))
      return true
    }
    if (action === 'snapshot' && request.method === 'GET') {
      const since = optionalString(url.searchParams.get('since'))
      const before = optionalString(url.searchParams.get('before'))
      const after = optionalString(url.searchParams.get('after'))
      const rawEdge = optionalString(url.searchParams.get('edge'))
      const edge = rawEdge === 'earliest' || rawEdge === 'latest' ? rawEdge : undefined
      const around = optionalString(url.searchParams.get('around'))
      if (rawEdge && !edge) throw httpError(400, 'Live snapshot edge must be earliest or latest')
      const selectors = [since, before, after, edge, around].filter(Boolean)
      if (selectors.length > 1) throw httpError(400, 'Live snapshot accepts only one cursor or edge selector')
      const rawLimit = url.searchParams.get('limit')
      const requestedLimit = rawLimit === null ? LIVE_SNAPSHOT_DEFAULT_LIMIT : Number(rawLimit)
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
        throw httpError(400, 'Live snapshot limit must be a positive integer')
      }
      const limit = Math.min(LIVE_SNAPSHOT_MAX_LIMIT, requestedLimit)
      const window: LiveSnapshotWindow = {
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
        ...(edge ? { edge } : {}),
        ...(around ? { around } : {}),
        limit,
      }
      const snapshot = normalizePublicSnapshot(await shareAdapterRead(
        adapter,
        `snapshot:${runtimeSessionId}:${since ?? ''}:${before ?? ''}:${after ?? ''}:${edge ?? ''}:${around ?? ''}:${limit}`,
        () => adapter.snapshot(runtimeSessionId, since, window),
      ))
      markRuntimeValidated(adapter, runtimeSessionId)
      writeJson(response, 200, jsonValue(snapshot))
      return true
    }
    if (action === 'history-index' && request.method === 'GET') {
      requireCapability(adapter, 'history-index')
      if (!adapter.historyIndex) {
        throw httpError(409, `${adapter.manifest.displayName} does not expose Live history index`)
      }
      const requested = Number(url.searchParams.get('limit') ?? LIVE_HISTORY_INDEX_MAX_LIMIT)
      if (!Number.isInteger(requested) || requested < 2) {
        throw httpError(400, 'Live history index limit must be an integer >= 2')
      }
      const limit = Math.min(LIVE_HISTORY_INDEX_MAX_LIMIT, requested)
      const index = normalizeHistoryIndex(await shareAdapterRead(
        adapter,
        `history-index:${runtimeSessionId}:${limit}`,
        () => adapter.historyIndex!(runtimeSessionId, limit),
      ))
      markRuntimeValidated(adapter, runtimeSessionId)
      writeJson(response, 200, jsonValue(index))
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

    if (action === 'workspace-references' && request.method === 'GET') {
      requireCapability(adapter, 'workspace-file-reference')
      if (!adapter.workspaceFileReferences) {
        throw httpError(409, `${adapter.manifest.displayName} does not expose workspace file references`)
      }
      const query = url.searchParams.get('q') ?? ''
      const requestedLimit = Number(url.searchParams.get('limit') ?? 20)
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 20
      writeJson(response, 200, {
        items: jsonValue(await shareAdapterRead(
          adapter,
          `workspace-references:${runtimeSessionId}:${query}:${limit}`,
          () => adapter.workspaceFileReferences!(runtimeSessionId, query, limit),
        )),
      })
      return true
    }

    if (action === 'message-actions' && request.method === 'GET') {
      writeJson(response, 200, {
        items: jsonValue(normalizeMessageActions(adapter.messageActions
          ? await shareAdapterRead(
              adapter,
              `message-actions:${runtimeSessionId}`,
              () => adapter.messageActions!(runtimeSessionId),
            )
          : [])),
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
      const declared = normalizeMessageActions(await adapter.messageActions(runtimeSessionId))
      if (!declared.some(action => action.actionId === actionId)) {
        throw httpError(409, 'Live message action is not currently declared by this adapter')
      }
      const result = normalizeMessageActionResult(await adapter.executeMessageAction(
        runtimeSessionId,
        actionId,
        targetEntryId,
      ))
      writeJson(response, 200, jsonValue(result))
      return true
    }

    if (action === 'runtime-disclosures' && request.method === 'GET') {
      writeJson(response, 200, {
        items: jsonValue(normalizeRuntimeDisclosures(adapter.runtimeDisclosures
          ? await shareAdapterRead(
              adapter,
              `runtime-disclosures:${runtimeSessionId}`,
              () => adapter.runtimeDisclosures!(runtimeSessionId),
            )
          : [])),
      })
      return true
    }
    if (action === 'runtime-actions' && request.method === 'POST') {
      if (!adapter.executeRuntimeAction || !adapter.runtimeDisclosures) {
        throw httpError(409, `${adapter.manifest.displayName} does not expose Live runtime actions`)
      }
      const body = objectBody(await readJson(request))
      const actionId = optionalString(body.actionId)
      if (!actionId) throw httpError(400, 'actionId is required')
      if (actionId.length > MAX_LIVE_MESSAGE_ACTION_ID) throw httpError(400, 'actionId is too long')
      const declared = normalizeRuntimeDisclosures(await adapter.runtimeDisclosures(runtimeSessionId))
      const allowed = declared.some(item => item.actions?.some(action => action.actionId === actionId))
      if (!allowed) throw httpError(409, 'Live runtime action is not currently declared by this adapter')
      const result = normalizeRuntimeActionResult(await adapter.executeRuntimeAction(runtimeSessionId, actionId))
      writeJson(response, 200, jsonValue(result))
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
      writeJson(response, 200, jsonValue(normalizePublicRuntimeState(
        await adapter.setModelControl(runtimeSessionId, nonEmpty(body.value, 'value')),
      )))
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
      writeJson(response, 200, jsonValue(normalizePublicRuntimeState(
        await adapter.setThinkingControl(runtimeSessionId, nonEmpty(body.value, 'value')),
      )))
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
