import { randomUUID } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { serialize } from 'node:v8'

const VERSION = 1
const MAX_MESSAGE_BYTES = 1024 * 1024
const SNAPSHOT_CHUNK_BYTES = 384 * 1024
const MAX_SNAPSHOT_TRANSFERS = 8
const SNAPSHOT_TRANSFER_TTL_MS = 30_000
const LIVE_SNAPSHOT_DEFAULT_LIMIT = 120
const LIVE_SNAPSHOT_MAX_LIMIT = 500
const LIVE_HISTORY_INDEX_QUERY_MAX_LIMIT = 120
const MAX_OUTBOUND_MESSAGES = 256
const MAX_SEEN_REQUEST_IDS = 512
let runtimeSessionId = ''
let runtimeCwd = ''
let sdk
let loadedSdkEntry
let runtime
let session
let unsubscribe = () => {}
let extensionUi
let terminating = false
let sdkVersion
let runtimeMode = 'compatibility'
let capabilities
let packageUpdateCheck = 'checking'
let packageUpdates = []
let roundIndexCache
let initializationStartedAt = 0
let currentInitializationStage
let currentStageStartedAt = 0
let initializationTimings = []
const seenRequestIds = new Set()
const snapshotTransfers = new Map()
const outboundQueue = []
let outboundSending = false
let exitAfterFlush = false

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function diagnostic(value) {
  return String(value ?? '')
    .replace(/(?:api[_-]?key|token|authorization|password)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1_000)
}

function uniqueStrings(values, limit = 240) {
  const seen = new Set()
  const result = []
  for (const raw of values) {
    const value = diagnostic(raw).trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
    if (result.length >= limit) break
  }
  return result
}

function resultItems(value, key) {
  if (Array.isArray(value)) return value
  const row = record(value)
  return Array.isArray(row[key]) ? row[key] : []
}

function resourceName(value) {
  const row = record(value)
  return typeof row.name === 'string' && row.name.trim()
    ? row.name.trim()
    : typeof row.path === 'string' && row.path.trim()
      ? basename(row.path)
      : ''
}

function displayContextPath(value, cwd) {
  const row = record(value)
  const path = typeof row.path === 'string' ? row.path : typeof value === 'string' ? value : ''
  if (!path) return ''
  const inside = relative(cwd, path)
  return inside && !inside.startsWith('..') && !resolve(inside).startsWith('..')
    ? inside.replace(/\\/g, '/')
    : basename(path)
}

function extensionLabel(value) {
  const row = record(value)
  const path = [row.path, row.resolvedPath, row.sourcePath].find(item => typeof item === 'string' && item.trim())
  if (typeof path !== 'string') return resourceName(value)
  const normalized = path.replace(/\\/g, '/')
  const marker = '/node_modules/'
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex < 0) return basename(path)
  const tail = normalized.slice(markerIndex + marker.length).split('/').filter(Boolean)
  if (!tail.length) return basename(path)
  const packageParts = tail[0].startsWith('@') ? tail.slice(0, 2) : tail.slice(0, 1)
  const packageName = packageParts.join('/')
  let rest = tail.slice(packageParts.length).join('/').replace(/\.(?:mjs|cjs|js|ts)$/, '')
  rest = rest.replace(/\/index$/, '')
  if (rest === 'dist' || rest === 'src') return `${packageName}:${rest}`
  return rest && rest !== 'index' ? `${packageName}:${rest}` : packageName
}

function diagnosticMessages(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.flatMap(diagnosticMessages)
  if (typeof value === 'string' || value instanceof Error) return [diagnostic(value instanceof Error ? value.message : value)]
  const row = record(value)
  const nested = [row.diagnostics, row.errors].flatMap(diagnosticMessages)
  const own = row.message ?? row.error ?? row.reason
  return own ? [...nested, diagnostic(typeof own === 'string' ? own : JSON.stringify(own))] : nested
}

function callResourceLoader(loader, method) {
  try {
    return loader && typeof loader[method] === 'function' ? loader[method]() : undefined
  } catch (error) {
    return { diagnostics: [error instanceof Error ? error.message : String(error)] }
  }
}

function piOfflineModeEnabled() {
  return Boolean(process.env.PI_OFFLINE)
}

function normalizePackageUpdates(value) {
  if (!Array.isArray(value)) return []
  const result = []
  for (const item of value) {
    const row = record(item)
    if (typeof row.displayName !== 'string') continue
    if (row.type !== 'npm' && row.type !== 'git') continue
    if (row.scope !== 'user' && row.scope !== 'project') continue
    result.push({
      displayName: row.displayName,
      type: row.type,
      scope: row.scope,
    })
  }
  return result
}

async function checkPackageUpdates(cwd) {
  if (piOfflineModeEnabled()) return { status: 'unavailable', updates: [] }
  if (typeof sdk?.DefaultPackageManager !== 'function' || typeof sdk?.getAgentDir !== 'function') {
    return { status: 'unavailable', updates: [] }
  }
  const settingsManager = record(session).settingsManager
  if (!settingsManager) return { status: 'unavailable', updates: [] }
  try {
    const manager = new sdk.DefaultPackageManager({
      cwd,
      agentDir: sdk.getAgentDir(),
      settingsManager,
    })
    if (typeof manager.checkForAvailableUpdates !== 'function') {
      return { status: 'unavailable', updates: [] }
    }
    return {
      status: 'complete',
      updates: normalizePackageUpdates(await manager.checkForAvailableUpdates()),
    }
  } catch {
    return { status: 'failed', updates: [] }
  }
}

function startPackageUpdateCheck(cwd) {
  packageUpdateCheck = 'checking'
  packageUpdates = []
  void checkPackageUpdates(cwd).then(result => {
    if (terminating) return
    packageUpdateCheck = result.status
    packageUpdates = result.updates
    send('event', {
      type: 'package_updates',
      status: packageUpdateCheck,
      updates: packageUpdates,
    })
  })
}

function startupResourceSnapshot(resourceLoader, cwd, extraDiagnostics, fallbackExtensions) {
  const loader = resourceLoader && typeof resourceLoader === 'object' ? resourceLoader : undefined
  if (!loader) return undefined
  const extensionsResult = callResourceLoader(loader, 'getExtensions') ?? fallbackExtensions
  const skillsResult = callResourceLoader(loader, 'getSkills')
  const promptsResult = callResourceLoader(loader, 'getPrompts')
  const themesResult = callResourceLoader(loader, 'getThemes')
  const agentsResult = callResourceLoader(loader, 'getAgentsFiles')
  return {
    contexts: uniqueStrings(resultItems(agentsResult, 'agentsFiles').map(item => displayContextPath(item, cwd))),
    skills: uniqueStrings(resultItems(skillsResult, 'skills').map(resourceName)),
    prompts: uniqueStrings(resultItems(promptsResult, 'prompts').map(resourceName)),
    extensions: uniqueStrings(resultItems(extensionsResult, 'extensions').map(extensionLabel)),
    themes: uniqueStrings(resultItems(themesResult, 'themes').map(resourceName)),
    diagnostics: uniqueStrings([
      ...diagnosticMessages(extraDiagnostics),
      ...diagnosticMessages(extensionsResult),
      ...diagnosticMessages(skillsResult),
      ...diagnosticMessages(promptsResult),
      ...diagnosticMessages(themesResult),
      ...diagnosticMessages(agentsResult),
    ], 80),
  }
}

function isCoalescibleEnvelope(envelope) {
  if (envelope.type !== 'event') return false
  const payload = record(envelope.payload)
  if (payload.type !== 'message_update') return false
  const update = record(payload.assistantMessageEvent)
  return (update.type === 'text_delta' || update.type === 'thinking_delta') && typeof update.delta === 'string'
}

function mergeCoalescibleEnvelope(target, incoming) {
  if (!isCoalescibleEnvelope(target) || !isCoalescibleEnvelope(incoming)) return false
  const targetPayload = record(target.payload)
  const incomingPayload = record(incoming.payload)
  const targetUpdate = record(targetPayload.assistantMessageEvent)
  const incomingUpdate = record(incomingPayload.assistantMessageEvent)
  if (targetUpdate.type !== incomingUpdate.type || targetUpdate.contentIndex !== incomingUpdate.contentIndex) return false
  target.payload = {
    ...targetPayload,
    ...incomingPayload,
    assistantMessageEvent: {
      ...targetUpdate,
      ...incomingUpdate,
      delta: `${targetUpdate.delta ?? ''}${incomingUpdate.delta ?? ''}`,
    },
  }
  return true
}

function failTransport(error) {
  process.stderr.write(`[pi-worker-ipc] ${diagnostic(error instanceof Error ? error.message : error)}\n`)
  void dispose().finally(() => process.exit(1))
}

function flushOutbound() {
  if (outboundSending) return
  if (!process.send || !process.connected) {
    if (outboundQueue.length) failTransport(new Error('Pi Runtime Worker IPC disconnected with pending outbound messages'))
    return
  }
  const envelope = outboundQueue.shift()
  if (!envelope) {
    if (exitAfterFlush) process.exit(0)
    return
  }
  outboundSending = true
  process.send(envelope, error => {
    outboundSending = false
    if (error) {
      failTransport(error)
      return
    }
    flushOutbound()
  })
}

function enqueueEnvelope(envelope) {
  if (isCoalescibleEnvelope(envelope)) {
    const tail = outboundQueue.at(-1)
    if (tail && mergeCoalescibleEnvelope(tail, envelope)) return true
  }
  if (outboundQueue.length >= MAX_OUTBOUND_MESSAGES) {
    const disposableIndex = outboundQueue.findIndex(isCoalescibleEnvelope)
    if (disposableIndex >= 0) outboundQueue.splice(disposableIndex, 1)
    else {
      failTransport(new Error('Pi Runtime Worker critical IPC queue overflow'))
      return false
    }
  }
  outboundQueue.push(envelope)
  flushOutbound()
  return true
}

function send(type, payload, requestId, ok = true, error) {
  if (!process.send || runtimeSessionId === undefined) return false
  const envelope = { version: VERSION, runtimeSessionId, type, ...(requestId ? { requestId } : {}), ...(payload !== undefined ? { payload } : {}), ...(type === 'response' ? { ok } : {}), ...(error ? { error: diagnostic(error) } : {}) }
  let size
  try { size = serialize(envelope).byteLength } catch { return false }
  if (size > MAX_MESSAGE_BYTES) {
    if (type === 'response' && requestId) return enqueueEnvelope({ version: VERSION, runtimeSessionId, type, requestId, ok: false, error: 'Pi Runtime Worker response exceeded size limit' })
    return false
  }
  return enqueueEnvelope(envelope)
}

function formatElapsed(elapsedMs) {
  return elapsedMs < 1_000 ? `${elapsedMs}ms` : `${(elapsedMs / 1_000).toFixed(1)}s`
}

function progress(stage, message) {
  const now = Date.now()
  if (!initializationStartedAt) {
    initializationStartedAt = now
    currentInitializationStage = stage
    currentStageStartedAt = now
  } else if (currentInitializationStage && currentInitializationStage !== stage) {
    initializationTimings = [...initializationTimings, { stage: currentInitializationStage, durationMs: Math.max(0, now - currentStageStartedAt) }]
    currentInitializationStage = stage
    currentStageStartedAt = now
  }
  const elapsedMs = Math.max(0, now - initializationStartedAt)
  send('event', {
    type: 'runtime_initialization',
    stage,
    message: stage === 'ready' ? `${message} · ${formatElapsed(elapsedMs)}` : message,
    elapsedMs,
    timings: initializationTimings,
  })
}

function rememberRequestId(requestId) {
  if (seenRequestIds.has(requestId)) return false
  seenRequestIds.add(requestId)
  while (seenRequestIds.size > MAX_SEEN_REQUEST_IDS) {
    const oldest = seenRequestIds.values().next().value
    if (oldest === undefined) break
    seenRequestIds.delete(oldest)
  }
  return true
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

function samePath(left, right) {
  const normalized = value => {
    const path = resolve(value)
    return process.platform === 'win32' ? path.toLowerCase() : path
  }
  return normalized(left) === normalized(right)
}

function pruneSnapshotTransfers(now = Date.now()) {
  for (const [transferId, transfer] of snapshotTransfers) {
    if (transfer.expiresAt <= now) snapshotTransfers.delete(transferId)
  }
}

function nextSnapshotChunk(transferId) {
  pruneSnapshotTransfers()
  const transfer = snapshotTransfers.get(transferId)
  if (!transfer) throw new Error('Unknown or expired Pi Runtime snapshot transfer')
  transfer.expiresAt = Date.now() + SNAPSHOT_TRANSFER_TTL_MS
  const start = transfer.offset
  const end = Math.min(transfer.bytes.length, start + SNAPSHOT_CHUNK_BYTES)
  const chunk = transfer.bytes.subarray(start, end)
  const sequence = transfer.sequence
  transfer.offset = end
  transfer.sequence += 1
  const done = end >= transfer.bytes.length
  if (done) snapshotTransfers.delete(transferId)
  return { transferId, sequence, chunk, done }
}

function snapshotLimit(window) {
  const requested = record(window).limit
  return Number.isInteger(requested)
    ? Math.max(1, Math.min(LIVE_SNAPSHOT_MAX_LIMIT, requested))
    : LIVE_SNAPSHOT_DEFAULT_LIMIT
}

function entryId(value) {
  const id = record(value).id
  return typeof id === 'string' && id ? id : undefined
}

function roundIndex(all = session.sessionManager.getEntries()) {
  const lastEntryId = all.length ? entryId(all.at(-1)) : undefined
  const leafId = session.sessionManager.getLeafId()
  const cached = roundIndexCache
  if (cached && cached.entryCount === all.length && cached.lastEntryId === lastEntryId && cached.leafId === leafId) return cached.rows

  const appendOnly = cached
    && all.length >= cached.entryCount
    && (cached.entryCount === 0 || entryId(all[cached.entryCount - 1]) === cached.lastEntryId)
  const rows = appendOnly ? [...cached.rows] : []
  const entryPositions = appendOnly ? new Map(cached.entryPositions) : new Map()
  const start = appendOnly ? cached.entryCount : 0

  for (let entryIndex = start; entryIndex < all.length; entryIndex += 1) {
    const entry = record(all[entryIndex])
    const id = entryId(entry)
    if (id) entryPositions.set(id, entryIndex)
    const message = record(entry.message)
    const cursor = entryId(entry)
    if (entry.type !== 'message' || message.role !== 'user' || !cursor) continue
    const content = message.content ?? entry.content
    const preview = Array.isArray(content)
      ? content.map(part => typeof part === 'string'
        ? part
        : typeof record(part).text === 'string' ? String(record(part).text) : '').join(' ')
      : typeof content === 'string' ? content : ''
    rows.push({
      cursor,
      ordinal: rows.length + 1,
      entryIndex,
      ...(preview.trim() ? { preview: preview.replace(/\s+/g, ' ').trim().slice(0, 86) } : {}),
    })
  }

  roundIndexCache = { entryCount: all.length, lastEntryId, leafId, rows, entryPositions }
  return rows
}

function snapshotRoundPage(all, start, end) {
  if (!roundIndexCache) return undefined
  const rows = roundIndex(all)
  let first
  let last
  for (const row of rows) {
    if (row.entryIndex < start) continue
    if (row.entryIndex >= end) break
    first ??= row
    last = row
  }
  return {
    total: rows.length,
    ...(first ? { firstOrdinal: first.ordinal } : {}),
    ...(last ? { lastOrdinal: last.ordinal } : {}),
  }
}

function beginSnapshotTransfer(since, window) {
  const requestedWindow = record(window)
  const before = typeof requestedWindow.before === 'string' ? requestedWindow.before : ''
  const afterCursor = typeof requestedWindow.after === 'string' ? requestedWindow.after : ''
  const edge = requestedWindow.edge === 'earliest' || requestedWindow.edge === 'latest' ? requestedWindow.edge : ''
  const around = typeof requestedWindow.around === 'string' ? requestedWindow.around : ''
  const selectors = [since, before, afterCursor, edge, around].filter(Boolean)
  if (selectors.length > 1) throw new Error('Live snapshot accepts only one cursor or edge selector')

  const all = session.sessionManager.getEntries()
  if (roundIndexCache) roundIndex(all)
  const entryPosition = cursor => cursor
    ? roundIndexCache?.entryPositions?.get(cursor) ?? entryPosition(cursor)
    : -1
  const limit = snapshotLimit(requestedWindow)
  let start = 0
  let end = all.length

  if (since || afterCursor) {
    const cursor = since || afterCursor
    const index = entryPosition(cursor)
    if (index < 0 && afterCursor) throw new Error('Live snapshot after cursor was not found')
    start = index >= 0 ? index + 1 : Math.max(0, all.length - limit)
    end = Math.min(all.length, start + limit)
  } else if (edge === 'earliest') {
    start = 0
    end = Math.min(all.length, limit)
  } else if (around) {
    const aroundIndex = entryPosition(around)
    if (aroundIndex < 0) throw new Error('Live snapshot around cursor was not found')
    start = Math.max(0, aroundIndex - Math.floor(limit * .3))
    end = Math.min(all.length, start + limit)
    start = Math.max(0, end - limit)
  } else {
    if (before) {
      const beforeIndex = entryPosition(before)
      if (beforeIndex < 0) throw new Error('Live snapshot before cursor was not found')
      end = beforeIndex
    }
    start = Math.max(0, end - limit)
  }

  const entries = all.slice(start, end)
  const firstCursor = entries.length ? entryId(entries[0]) : undefined
  const lastCursor = entries.length ? entryId(entries.at(-1)) : undefined
  const olderCursor = start > 0 ? firstCursor : undefined
  const newerCursor = end < all.length ? lastCursor : undefined
  const rounds = snapshotRoundPage(all, start, end)
  const page = {
    hasEarlier: start > 0,
    ...(start > 0 && olderCursor ? { before: olderCursor } : {}),
    ...(firstCursor ? { first: firstCursor } : {}),
    ...(lastCursor ? { last: lastCursor } : {}),
    ...(rounds ? { rounds } : {}),
    ...(end < all.length ? { hasLater: true, ...(newerCursor ? { after: newerCursor } : {}) } : {}),
  }

  const snapshot = { state: state(), entries, leafId: session.sessionManager.getLeafId(), page }
  const bytes = serialize(snapshot)

  pruneSnapshotTransfers()
  if (snapshotTransfers.size >= MAX_SNAPSHOT_TRANSFERS) {
    throw new Error('Pi Runtime has too many concurrent snapshot transfers')
  }

  const transferId = randomUUID()
  snapshotTransfers.set(transferId, {
    bytes,
    offset: 0,
    sequence: 0,
    expiresAt: Date.now() + SNAPSHOT_TRANSFER_TTL_MS,
  })
  return nextSnapshotChunk(transferId)
}

function historyIndex(queryValue) {
  const query = record(queryValue)
  const rows = roundIndex()
  const cursor = typeof query.cursor === 'string' ? query.cursor.trim() : ''
  if (cursor) {
    const row = rows.find(item => item.cursor === cursor)
    return {
      total: rows.length,
      items: row ? [{
        cursor: row.cursor,
        ordinal: row.ordinal,
        ...(row.preview ? { preview: row.preview } : {}),
      }] : [],
    }
  }

  const limit = Number.isInteger(query.limit)
    ? Math.max(0, Math.min(LIVE_HISTORY_INDEX_QUERY_MAX_LIMIT, query.limit))
    : 0
  if (limit === 0) return { total: rows.length, items: [] }

  const fromOrdinal = Number.isInteger(query.fromOrdinal) && query.fromOrdinal > 0
    ? query.fromOrdinal
    : 1
  const start = Math.min(rows.length, fromOrdinal - 1)
  return {
    total: rows.length,
    items: rows.slice(start, start + limit).map(({ entryIndex, ...item }) => item),
  }
}

function resolvedRuntimeSessionDir(cwd, value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const raw = value.trim()
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || (process.platform === 'win32' && raw.startsWith('~\\'))) {
    return resolve(homedir(), raw.slice(2))
  }
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
}

async function createSessionManager(sdk, input) {
  const sessionDir = resolvedRuntimeSessionDir(input.cwd, input.sessionDir)
  if (!input.sessionPath) return sdk.SessionManager.create(input.cwd, sessionDir)
  const manager = sdk.SessionManager.open(input.sessionPath, sessionDir, input.cwd)
  if (input.historyAction !== 'fork') return manager
  if (typeof manager.createBranchedSession !== 'function' || typeof manager.newSession !== 'function') {
    throw new Error('Installed Pi SDK does not support message-level session fork')
  }
  const hasExplicitTarget = Object.hasOwn(input, 'branchFromEntryId')
  const leafId = hasExplicitTarget ? input.branchFromEntryId : manager.getLeafId()
  if (hasExplicitTarget && leafId === null) {
    const fresh = sdk.SessionManager.create(input.cwd, sessionDir)
    if (typeof fresh.newSession !== 'function') {
      throw new Error('Installed Pi SDK does not support root message fork')
    }
    fresh.newSession({ parentSession: input.sessionPath })
    return fresh
  }
  if (typeof leafId !== 'string' || !leafId) throw new Error('该 Pi 历史会话没有可分叉的目标节点')
  const forkedSessionPath = await Promise.resolve(manager.createBranchedSession(leafId))
  if (typeof forkedSessionPath !== 'string' || !forkedSessionPath.trim()) {
    throw new Error('Pi 未能从当前节点创建新的 Session')
  }
  if (samePath(forkedSessionPath, input.sessionPath)) {
    throw new Error('Pi 分叉返回了原会话路径，已拒绝覆盖历史 Session')
  }
  if (!await exists(forkedSessionPath)) {
    throw new Error('Pi 已返回分叉 Session 路径，但新 JSONL 尚未创建')
  }
  return manager
}

async function loadSdk(discovery) {
  const sdkEntry = typeof discovery.sdkEntry === 'string' ? discovery.sdkEntry : ''
  if (!sdkEntry) throw new Error('Pi Runtime Worker did not receive a verified official Pi SDK entry')
  if (!await exists(sdkEntry)) throw new Error(`Verified Pi SDK entry no longer exists: ${sdkEntry}`)
  if (sdk) {
    if (!samePath(loadedSdkEntry, sdkEntry)) throw new Error('Pi Runtime Worker cannot switch SDK after prewarm')
    return sdk
  }
  sdkVersion = typeof discovery.version === 'string' ? discovery.version : undefined
  sdk = await import(pathToFileURL(sdkEntry).href)
  if (typeof sdk.createAgentSession !== 'function' || !sdk.SessionManager) throw new Error('Installed Pi SDK is missing required AgentSession capabilities')
  loadedSdkEntry = sdkEntry
  return sdk
}

function wireEvent(event) {
  const value = record(event)
  if (value.type !== 'message_update') return value
  const message = record(value.message)
  const assistantEvent = record(value.assistantMessageEvent)
  const { partial, ...deltaEvent } = assistantEvent
  if (assistantEvent.type === 'toolcall_start') {
    const content = Array.isArray(record(partial).content) ? record(partial).content : []
    const index = typeof assistantEvent.contentIndex === 'number' ? assistantEvent.contentIndex : -1
    const toolCall = index >= 0 ? record(content[index]) : {}
    return { type: 'message_update', usage: message.usage, assistantMessageEvent: { ...deltaEvent, id: toolCall.id, toolName: toolCall.name } }
  }
  return { type: 'message_update', usage: message.usage, assistantMessageEvent: deltaEvent }
}

function fallbackTheme() {
  const decorate = (...args) => String(args.at(-1) ?? '')
  return new Proxy({ fg: decorate, bg: decorate, bold: decorate, italic: decorate, underline: decorate }, { get(target, property) { return property in target ? target[property] : decorate } })
}

function createExtensionUi() {
  const pending = new Map()
  let editorText = ''
  const fire = payload => send('event', { type: 'extension_ui_request', id: randomUUID(), ...payload })
  const dialog = (method, payload, options, fallback, parse) => {
    if (options?.signal?.aborted) return Promise.resolve(fallback)
    const id = randomUUID()
    return new Promise(resolveDialog => {
      const finish = value => { pending.delete(id); resolveDialog(value) }
      const onAbort = () => finish(fallback)
      options?.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = options?.timeout > 0 ? setTimeout(onAbort, options.timeout) : undefined
      pending.set(id, { finish: response => { if (timer) clearTimeout(timer); options?.signal?.removeEventListener('abort', onAbort); finish(parse(record(response))) }, cancel: onAbort })
      send('event', { type: 'extension_ui_request', id, method, ...payload })
    })
  }
  return {
    context: {
      select: (title, choices, options) => dialog('select', { title, options: choices }, options, undefined, response => response.cancelled ? undefined : response.value),
      confirm: (title, message, options) => dialog('confirm', { title, message }, options, false, response => response.cancelled ? false : response.confirmed === true),
      input: (title, placeholder, options) => dialog('input', { title, placeholder }, options, undefined, response => response.cancelled ? undefined : response.value),
      notify: (message, notifyType) => fire({ method: 'notify', message, notifyType }),
      onTerminalInput: () => () => {}, setStatus: (statusKey, statusText) => fire({ method: 'setStatus', statusKey, statusText }),
      setWorkingMessage: () => {}, setWorkingVisible: () => {}, setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {},
      setWidget: (widgetKey, widgetLines, options) => fire({ method: 'setWidget', widgetKey, widgetLines, widgetPlacement: options?.placement }),
      setFooter: () => {}, setHeader: () => {}, setTitle: title => fire({ method: 'setTitle', title }), custom: async () => undefined,
      pasteToEditor: text => { editorText = text; fire({ method: 'set_editor_text', text }) },
      setEditorText: text => { editorText = text; fire({ method: 'set_editor_text', text }) }, getEditorText: () => editorText,
      editor: (title, prefill) => dialog('editor', { title, prefill }, undefined, undefined, response => response.cancelled ? undefined : response.value),
      addAutocompleteProvider: () => {}, setEditorComponent: () => {}, getEditorComponent: () => undefined,
      theme: fallbackTheme(), getAllThemes: () => [], getTheme: () => undefined,
      setTheme: () => ({ success: false, error: 'Theme switching is not supported by AgentLens' }),
      getToolsExpanded: () => false, setToolsExpanded: () => {},
    },
    respond(id, response) {
      const item = pending.get(id)
      if (!item) return false
      item.finish(response)
      return true
    },
    dispose() { for (const item of pending.values()) item.cancel(); pending.clear() },
  }
}

function runtimeCapabilities(hasSessionRuntime) {
  return {
    protocolVersion: VERSION,
    ...(sdkVersion ? { sdkVersion } : {}),
    sessionRuntime: hasSessionRuntime,
    modelSwitching: typeof session?.setModel === 'function',
    thinkingLevelControl: typeof session?.setThinkingLevel === 'function' && typeof session?.getAvailableThinkingLevels === 'function',
    extensionUi: typeof session?.bindExtensions === 'function',
    treeNavigation: typeof session?.navigateTree === 'function',
    messageFork: typeof session?.sessionManager?.createBranchedSession === 'function'
      && typeof session?.sessionManager?.newSession === 'function',
  }
}

function handshakeDiagnostics() {
  return {
    ...(capabilities ? { capabilities } : {}),
    initializationElapsedMs: initializationStartedAt ? Math.max(0, Date.now() - initializationStartedAt) : 0,
    initializationTimings,
  }
}

async function initialize(input) {
  runtimeCwd = typeof input.cwd === 'string' ? input.cwd : ''
  initializationStartedAt = Date.now()
  currentInitializationStage = undefined
  currentStageStartedAt = initializationStartedAt
  initializationTimings = []
  packageUpdateCheck = 'checking'
  packageUpdates = []
  progress('loading_sdk', '正在加载 Pi SDK')
  const loadedSdk = await loadSdk(record(input.sdk))
  const sessionManager = await createSessionManager(loadedSdk, input)
  const hasSessionRuntime = ['createAgentSessionServices', 'createAgentSessionRuntime', 'createAgentSessionFromServices'].every(name => typeof loadedSdk[name] === 'function')
  if (hasSessionRuntime) {
    runtimeMode = 'session_runtime'
    const agentDir = loadedSdk.getAgentDir()
    const createRuntime = async options => {
      progress('loading_resources', '正在加载配置、扩展与上下文')
      const services = await loadedSdk.createAgentSessionServices({ cwd: options.cwd, agentDir: options.agentDir, modelRuntimeSignal: AbortSignal.timeout(15_000) })
      const resources = startupResourceSnapshot(services.resourceLoader, input.cwd, services.diagnostics)
      if (resources) send('event', { type: 'runtime_resources', resources })
      progress('creating_session', '正在创建 Pi Session')
      const created = await loadedSdk.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent })
      return { ...created, services, diagnostics: services.diagnostics }
    }
    runtime = await loadedSdk.createAgentSessionRuntime(createRuntime, { cwd: input.cwd, agentDir, sessionManager })
    session = runtime.session
  } else {
    progress('loading_resources', '正在使用兼容模式加载 Pi 配置与扩展')
    progress('creating_session', '正在创建 Pi Session')
    const created = await loadedSdk.createAgentSession({ cwd: input.cwd, sessionManager })
    const compatibilityLoader = record(created).resourceLoader ?? record(record(created).services).resourceLoader
    const compatibilityResources = startupResourceSnapshot(compatibilityLoader, input.cwd, record(created).diagnostics, record(created).extensionsResult)
    if (compatibilityResources) send('event', { type: 'runtime_resources', resources: compatibilityResources })
    session = created.session
    runtime = { dispose: async () => session.dispose() }
  }
  capabilities = runtimeCapabilities(hasSessionRuntime)
  send('event', { type: 'runtime_capabilities', capabilities })
  extensionUi = createExtensionUi()
  unsubscribe = session.subscribe(event => send('event', wireEvent(event)))
  progress('binding_extensions', '正在绑定扩展界面')
  await session.bindExtensions({
    uiContext: extensionUi.context,
    mode: 'rpc',
    abortHandler: () => { void session.abort() },
    onError: value => send('event', { type: 'extension_error', error: diagnostic(record(value).error ?? 'Unknown extension error') }),
  })
  // resources_discover runs during bindExtensions() and may extend skills/prompts/themes.
  // Emit a post-bind snapshot so the service sees the actual runtime resource set rather than
  // only the pre-session loader state.
  const finalResourceLoader = record(session).resourceLoader
  const finalResources = startupResourceSnapshot(finalResourceLoader, input.cwd)
  if (finalResources) send('event', { type: 'runtime_resources', resources: finalResources })
  if (input.name) session.setSessionName(input.name)
  if (input.provider || input.model) await selectModel(input.provider, input.model)
  progress('ready', 'Pi Runtime 已就绪')
  startPackageUpdateCheck(input.cwd)
}

function state() {
  const resources = startupResourceSnapshot(record(session).resourceLoader, runtimeCwd)
  return {
    runtimeSessionId, status: 'ready', initializationStage: 'ready', initializationMessage: `Pi Runtime 已就绪 · ${formatElapsed(handshakeDiagnostics().initializationElapsedMs)}`,
    ...handshakeDiagnostics(),
    sdkVersion, runtimeMode, nativeSessionId: session.sessionId, ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
    ...(session.sessionName ? { sessionName: session.sessionName } : {}), ...(session.model ? { model: session.model } : {}),
    thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming, isCompacting: session.isCompacting,
    pendingMessageCount: session.pendingMessageCount, leafId: session.sessionManager.getLeafId(), processId: process.pid,
    ...(resources ? { startupResources: resources } : {}),
    packageUpdateCheck,
    ...(packageUpdates.length ? { packageUpdates } : {}),
  }
}

function modelSnapshot(provider) {
  const snapshot = [...session.modelRuntime.getAvailableSnapshot()]
  const selected = session.model
  const catalog = selected && !snapshot.some(model => model.provider === selected.provider && model.id === selected.id)
    ? [...snapshot, selected]
    : snapshot
  return provider ? catalog.filter(model => model.provider === provider) : catalog
}

async function modelsForSelection(provider) {
  const snapshot = modelSnapshot(provider)
  return snapshot.length ? snapshot : await session.modelRuntime.getAvailable(provider)
}

async function selectModel(provider, modelId) {
  const available = await modelsForSelection(provider)
  const model = available.find(item => (!provider || item.provider === provider) && (!modelId || item.id === modelId || item.name === modelId))
  if (!model) throw new Error(`Pi model is not available: ${[provider, modelId].filter(Boolean).join('/') || 'requested model'}`)
  await session.setModel(model)
}

function slashCommands() {
  const commands = []

  const registered = session?.extensionRunner?.getRegisteredCommands?.()
  if (Array.isArray(registered)) {
    for (const item of registered) {
      const command = record(item)
      const name = typeof command.invocationName === 'string' ? command.invocationName.trim() : ''
      if (!name) continue
      commands.push({
        name,
        ...(typeof command.description === 'string' && command.description.trim()
          ? { description: command.description.trim() }
          : {}),
        source: 'extension',
      })
    }
  }

  const templates = Array.isArray(session?.promptTemplates) ? session.promptTemplates : []
  for (const item of templates) {
    const template = record(item)
    const name = typeof template.name === 'string' ? template.name.trim() : ''
    if (!name) continue
    commands.push({
      name,
      ...(typeof template.description === 'string' && template.description.trim()
        ? { description: template.description.trim() }
        : {}),
      source: 'prompt',
    })
  }

  const skillsResult = session?.resourceLoader?.getSkills?.()
  const skills = Array.isArray(record(skillsResult).skills) ? record(skillsResult).skills : []
  for (const item of skills) {
    const skill = record(item)
    const rawName = typeof skill.name === 'string' ? skill.name.trim() : ''
    if (!rawName) continue
    commands.push({
      name: `skill:${rawName}`,
      ...(typeof skill.description === 'string' && skill.description.trim()
        ? { description: skill.description.trim() }
        : {}),
      source: 'skill',
    })
  }

  return commands
}

function thinkingControl() {
  if (!capabilities?.thinkingLevelControl) return undefined
  const current = session?.thinkingLevel
  const levels = session?.getAvailableThinkingLevels?.()
  if (typeof current !== 'string' || !current || !Array.isArray(levels) || levels.length === 0) return undefined
  if (levels.some(level => typeof level !== 'string' || !level)) return undefined
  const options = levels.map(level => ({ value: level, label: level }))
  if (!options.some(option => option.value === current)) return undefined
  return { capability: 'thinking-control', value: current, options }
}

async function command(name, value = {}) {
  if (!session && name !== 'terminate') throw new Error('Pi Runtime is not ready')
  if (name === 'state') return state()
  if (name === 'snapshotBegin') return beginSnapshotTransfer(value.since, value.window)
  if (name === 'snapshotChunk') {
    if (typeof value.transferId !== 'string' || !value.transferId) throw new Error('Pi Runtime snapshot transfer id is required')
    return nextSnapshotChunk(value.transferId)
  }
  if (name === 'entry') {
    if (typeof value.entryId !== 'string' || !value.entryId) throw new Error('Pi Runtime entry id is required')
    return session.sessionManager.getEntries().find(entry => entryId(entry) === value.entryId) ?? null
  }
  if (name === 'historyIndex') return historyIndex(value)
  if (name === 'commands') return slashCommands()
  if (name === 'navigateTree') {
    if (typeof value.entryId !== 'string' || !value.entryId) throw new Error('Pi tree navigation entry id is required')
    if (session.isStreaming) throw new Error('Pi tree navigation requires an idle session')
    if (typeof session.navigateTree !== 'function') throw new Error('Installed Pi SDK does not support navigateTree')
    const result = await session.navigateTree(value.entryId)
    roundIndexCache = undefined
    return {
      cancelled: result?.cancelled === true,
      ...(typeof result?.editorText === 'string' ? { editorText: result.editorText } : {}),
    }
  }
  if (name === 'controls') {
    const thinking = thinkingControl()
    return {
      models: modelSnapshot().map(({ provider, id, name, reasoning }) => ({ provider, id, ...(name ? { name } : {}), ...(typeof reasoning === 'boolean' ? { reasoning } : {}) })),
      ...(thinking ? { thinking } : {}),
    }
  }
  if (name === 'setModel') { await selectModel(value.provider, value.modelId); return state() }
  if (name === 'setThinkingLevel') {
    const levels = session.getAvailableThinkingLevels()
    if (!levels.includes(value.level)) throw new Error(`Pi thinking level is not available: ${value.level}`)
    session.setThinkingLevel(value.level)
    return state()
  }
  if (name === 'prompt') {
    await new Promise((resolveAccepted, rejectAccepted) => {
      let accepted = false
      const accept = () => { if (!accepted) { accepted = true; resolveAccepted() } }
      void session.prompt(value.message, { ...(Array.isArray(value.images) && value.images.length ? { images: value.images } : {}), ...(value.behavior ? { streamingBehavior: value.behavior } : {}), source: 'rpc', preflightResult: success => { if (success) accept() } }).then(accept, error => accepted ? undefined : rejectAccepted(error))
    })
    return
  }
  if (name === 'steer') return await session.steer(value.message, Array.isArray(value.images) && value.images.length ? value.images : undefined)
  if (name === 'followUp') return await session.followUp(value.message, Array.isArray(value.images) && value.images.length ? value.images : undefined)
  if (name === 'clearQueue') return session.clearQueue()
  if (name === 'abort') { const queue = value.restoreQueue === false ? { steering: [], followUp: [] } : session.clearQueue(); session.abortBash?.(); await session.abort(); return queue }
  if (name === 'extensionResponse') {
    if (!extensionUi || !extensionUi.respond(value.requestId, value.response)) throw new Error(`Unknown or already settled Pi Extension request id: ${value.requestId ?? 'missing'}`)
    return
  }
  if (name === 'terminate') { await dispose(); return }
  throw new Error(`Unknown Pi Runtime Worker command: ${name}`)
}

async function dispose() {
  if (terminating) return
  terminating = true
  snapshotTransfers.clear()
  roundIndexCache = undefined
  unsubscribe()
  extensionUi?.dispose()
  if (session?.isStreaming) { session.abortBash?.(); await session.abort().catch(() => undefined) }
  await runtime?.dispose()
}

process.on('message', async value => {
  const envelope = record(value)
  if (envelope.version !== VERSION || typeof envelope.runtimeSessionId !== 'string') return
  if (envelope.type === 'prewarm') {
    if (runtimeSessionId || typeof envelope.requestId !== 'string') return
    if (!rememberRequestId(envelope.requestId)) return
    try {
      await loadSdk(record(record(envelope.payload).sdk))
      send('response', { sdkVersion }, envelope.requestId, true)
    } catch (error) {
      send('response', undefined, envelope.requestId, false, error instanceof Error ? error.message : String(error))
    }
    return
  }
  if (!runtimeSessionId) runtimeSessionId = envelope.runtimeSessionId
  if (envelope.runtimeSessionId !== runtimeSessionId) return
  if ((envelope.type === 'initialize' || envelope.type === 'request') && typeof envelope.requestId === 'string') {
    if (!rememberRequestId(envelope.requestId)) {
      send('response', undefined, envelope.requestId, false, `Duplicate Pi Runtime Worker request id: ${envelope.requestId}`)
      return
    }
  }
  if (envelope.type === 'initialize') {
    if (typeof envelope.requestId !== 'string') return
    try {
      await initialize(record(envelope.payload))
      send('response', handshakeDiagnostics(), envelope.requestId, true)
    } catch (error) {
      send('response', undefined, envelope.requestId, false, error instanceof Error ? error.message : String(error))
      await dispose().catch(() => undefined)
    }
    return
  }
  if (envelope.type !== 'request' || typeof envelope.requestId !== 'string') return
  const payload = record(envelope.payload)
  try {
    const result = await command(payload.command, record(payload.value))
    send('response', result, envelope.requestId, true)
    if (payload.command === 'terminate') {
      exitAfterFlush = true
      flushOutbound()
    }
  } catch (error) {
    send('response', undefined, envelope.requestId, false, error instanceof Error ? error.message : String(error))
  }
})

process.on('disconnect', () => { void dispose().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { void dispose().finally(() => process.exit(0)) })
