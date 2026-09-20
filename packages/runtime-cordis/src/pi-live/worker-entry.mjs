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
let baseAgentDir
let baseModelRuntime
let prewarmMetrics = []
let startupMetrics = []
let warmWorkerStatus
let runtime
let session
let unsubscribe = () => {}
let extensionUi
let extensionBindingPromise
let extensionBindingStatus
let extensionBindingError
let terminating = false
let sdkVersion
let runtimeMode = 'compatibility'
let capabilities
let packageUpdateCheck = 'checking'
let packageUpdates = []
let currentStartupResources
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

function publishStartupResources(resources) {
  if (!resources) return
  currentStartupResources = resources
  send('event', { type: 'runtime_resources', resources })
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

function recordStartupMetric(name, durationMs, options = {}) {
  const metric = {
    name,
    durationMs: Math.max(0, Number.isFinite(durationMs) ? durationMs : 0),
  }
  startupMetrics = [...startupMetrics.filter(item => item.name !== name), metric]
  if (runtimeSessionId) {
    send('event', {
      type: 'runtime_startup_metric',
      metric,
      ...(warmWorkerStatus ? { warmWorkerStatus } : {}),
      ...(options.prewarm === true ? { prewarm: true } : {}),
    })
  }
  return metric
}

async function ensureBaseRuntime(loadedSdk) {
  if (baseModelRuntime) return false
  if (typeof loadedSdk.ModelRuntime?.create !== 'function') return false
  baseAgentDir = typeof loadedSdk.getAgentDir === 'function' ? loadedSdk.getAgentDir() : undefined
  const startedAt = Date.now()
  baseModelRuntime = await loadedSdk.ModelRuntime.create({
    ...(baseAgentDir ? {
      authPath: join(baseAgentDir, 'auth.json'),
      modelsPath: join(baseAgentDir, 'models.json'),
    } : {}),
    allowModelNetwork: false,
  })
  const metric = { name: 'model_runtime_create_ms', durationMs: Math.max(0, Date.now() - startedAt) }
  return metric
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

function messageText(value) {
  const message = record(value)
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (typeof part === 'string') return part
    const item = record(part)
    return item.type === 'text' && typeof item.text === 'string' ? item.text : ''
  }).filter(Boolean).join('\n\n').trim()
}

function assistantBlocks(value) {
  const message = record(value)
  const content = Array.isArray(message.content) ? message.content : []
  return content.map(record)
}

function entryTimestampMs(value) {
  const row = record(value)
  const message = record(row.message)
  const raw = row.timestamp ?? message.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

const LIVE_HISTORY_META_EVENT_LIMIT = 24

function compactHistoryMeta(value, max = 240) {
  let text = ''
  if (typeof value === 'string') text = value
  else {
    try { text = JSON.stringify(value) ?? '' } catch { text = String(value ?? '') }
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function finiteHistoryNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function historyUsageEvent(id, value, at, phase) {
  const usage = record(value)
  if (!Object.keys(usage).length) return undefined
  const input = finiteHistoryNumber(usage.input ?? usage.inputTokens) ?? 0
  const output = finiteHistoryNumber(usage.output ?? usage.outputTokens) ?? 0
  const cacheRead = finiteHistoryNumber(usage.cacheRead ?? usage.cache_read ?? usage.cacheReadTokens) ?? 0
  const cacheWrite = finiteHistoryNumber(usage.cacheWrite ?? usage.cache_write ?? usage.cacheWriteTokens) ?? 0
  const total = finiteHistoryNumber(usage.totalTokens ?? usage.total_tokens) ?? input + output + cacheRead + cacheWrite
  return {
    id: `${id}:usage`,
    category: 'usage',
    label: '用量',
    detail: `输入 ${input} · 输出 ${output} · 共 ${total} tokens`,
    ...(at ? { at } : {}),
    phase,
  }
}

function historyMetaEvents(entryValue, fallbackIndex, phase) {
  const entry = record(entryValue)
  const id = entryId(entry) ?? `meta:${fallbackIndex}`
  const timestamp = entryTimestampMs(entry)
  const at = timestamp === undefined ? undefined : new Date(timestamp).toISOString()
  const type = typeof entry.type === 'string' ? entry.type : 'unknown'
  const message = record(entry.message)
  const role = typeof message.role === 'string' ? message.role : ''
  const events = []
  const push = (category, label, detail = '') => events.push({
    id,
    category,
    label,
    ...(detail ? { detail: compactHistoryMeta(detail) } : {}),
    ...(at ? { at } : {}),
    phase,
  })
  const pushUsage = value => {
    const usage = historyUsageEvent(id, value, at, phase)
    if (usage) events.push(usage)
  }

  if (type === 'message') {
    if (role === 'assistant' || role === 'toolResult' || role === 'tool') {
      pushUsage(message.usage)
      return events
    }
    if (role === 'branchSummary') push('context', '分支摘要', message.summary)
    else if (role === 'compactionSummary') push('context', '上下文已压缩', message.summary)
    else if (role === 'custom') push('lifecycle', `Pi 扩展消息 · ${message.customType ?? 'custom'}`, message.content)
    else if (role === 'bashExecution') push('lifecycle', 'Pi Bash', message.command ?? message.output)
    else if (role && role !== 'user') push('unknown', `Pi 消息 · ${role}`, message.content ?? message.text)
    pushUsage(message.usage)
    return events
  }

  if (type === 'model_change') {
    push('model', '模型已切换', [entry.provider, entry.modelId ?? entry.model].filter(Boolean).join(' / '))
  } else if (type === 'thinking_level_change') {
    push('model', '推理级别已切换', entry.thinkingLevel ?? entry.level)
  } else if (type === 'compaction') {
    push('context', '上下文已压缩', [entry.tokensBefore === undefined ? '' : `${entry.tokensBefore} tokens`, entry.summary].filter(Boolean).join(' · '))
  } else if (type === 'branch_summary') {
    push('context', '分支摘要', entry.summary)
  } else if (type === 'session_info') {
    push('lifecycle', '会话信息已更新', entry.name)
  } else if (type === 'custom' || type === 'custom_message') {
    push('lifecycle', `Pi 自定义事件 · ${entry.customType ?? entry.name ?? entry.event ?? 'custom'}`, entry.data ?? entry.payload ?? entry.content)
  } else if (type === 'label') {
    push('lifecycle', 'Pi 标签', entry.label ?? entry.name)
  } else if (type === 'bash' || type === 'bash_result') {
    push('lifecycle', type === 'bash' ? 'Pi Bash' : 'Pi Bash 结果', entry.command ?? entry.output)
  } else if (type !== 'session') {
    push('unknown', 'Pi 原生事件', type)
  }
  pushUsage(entry.usage)
  return events
}

function roundSummary(all, row, nextEntryIndex) {
  const start = row.entryIndex
  const end = Math.max(start + 1, nextEntryIndex)
  const entries = all.slice(start, end)
  const promptEntry = record(entries[0])
  const promptMessage = record(promptEntry.message)
  const promptText = messageText(promptMessage)

  let finalAssistantIndex = -1
  for (let index = entries.length - 1; index >= 1; index -= 1) {
    const entry = record(entries[index])
    const message = record(entry.message)
    if (entry.type !== 'message' || message.role !== 'assistant') continue
    const blocks = assistantBlocks(message)
    const hasToolCall = blocks.some(block => block.type === 'toolCall')
    const text = messageText(message)
    if (!hasToolCall && text) {
      finalAssistantIndex = index
      break
    }
  }

  let itemCount = 0
  let messageCount = 0
  let toolCount = 0
  let errorCount = 0
  const processTimes = []
  const pairedToolCalls = new Set()
  for (let index = 1; index < entries.length; index += 1) {
    const entry = record(entries[index])
    const message = record(entry.message)
    if (entry.type !== 'message' || message.role !== 'assistant' || index === finalAssistantIndex) continue
    const blocks = assistantBlocks(message)
    const processMessages = blocks.filter(block => block.type === 'thinking' || block.type === 'text').length
      || (messageText(message) ? 1 : 0)
    const toolBlocks = blocks.filter(block => block.type === 'toolCall')
    messageCount += processMessages
    toolCount += toolBlocks.length
    itemCount += processMessages + toolBlocks.length
    for (const block of toolBlocks) {
      if (typeof block.id === 'string' && block.id) pairedToolCalls.add(block.id)
    }
    if (processMessages || toolBlocks.length) {
      const timestamp = entryTimestampMs(entry)
      if (timestamp !== undefined) processTimes.push(timestamp)
    }
  }
  for (let index = 1; index < entries.length; index += 1) {
    const entry = record(entries[index])
    const message = record(entry.message)
    if (entry.type !== 'message' || (message.role !== 'toolResult' && message.role !== 'tool')) continue
    const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
    if (!callId || !pairedToolCalls.has(callId)) {
      toolCount += 1
      itemCount += 1
    }
    if (message.isError === true || message.error === true) errorCount += 1
    const timestamp = entryTimestampMs(entry)
    if (timestamp !== undefined) processTimes.push(timestamp)
  }

  const allEvents = entries.flatMap((entry, index) => historyMetaEvents(
    entry,
    index,
    finalAssistantIndex >= 0 && index >= finalAssistantIndex ? 'after-final' : 'before-final',
  ))
  const events = allEvents.slice(0, LIVE_HISTORY_META_EVENT_LIMIT)
  const eventOmittedCount = Math.max(0, allEvents.length - events.length)

  const finalEntry = finalAssistantIndex >= 0 ? record(entries[finalAssistantIndex]) : undefined
  const finalMessage = finalEntry ? record(finalEntry.message) : {}
  const finalText = finalEntry ? messageText(finalMessage) : ''
  const provider = typeof finalMessage.provider === 'string' ? finalMessage.provider.trim() : ''
  const model = typeof finalMessage.model === 'string' ? finalMessage.model.trim() : ''
  const modelLabel = [provider, model].filter(Boolean).join(' / ')
  const stopReason = typeof finalMessage.stopReason === 'string'
    ? finalMessage.stopReason.trim()
    : typeof finalMessage.stop_reason === 'string'
      ? finalMessage.stop_reason.trim()
      : ''
  const errorMessage = typeof finalMessage.errorMessage === 'string'
    ? finalMessage.errorMessage.trim()
    : typeof finalMessage.error_message === 'string'
      ? finalMessage.error_message.trim()
      : ''
  const terminalStatus = stopReason === 'aborted'
    ? 'aborted'
    : stopReason === 'error' || errorMessage
      ? 'error'
      : stopReason
        ? 'completed'
        : ''
  const firstProcessAt = processTimes.length ? Math.min(...processTimes) : undefined
  const lastProcessAt = processTimes.length ? Math.max(...processTimes) : undefined
  const lastId = entries.length ? entryId(entries.at(-1)) : undefined

  return {
    ...(promptText ? { promptText } : {}),
    ...(finalText ? { finalText } : {}),
    ...(modelLabel ? { modelLabel } : {}),
    ...(events.length ? { events } : {}),
    ...(eventOmittedCount ? { eventOmittedCount } : {}),
    ...(terminalStatus ? {
      terminal: {
        status: terminalStatus,
        ...((stopReason || errorMessage) ? { detail: [stopReason, errorMessage].filter(Boolean).join(' · ') } : {}),
      },
    } : {}),
    process: {
      revision: [row.cursor, entries.length, lastId ?? 'empty'].join(':'),
      itemCount,
      messageCount,
      toolCount,
      errorCount,
      durationMs: firstProcessAt !== undefined && lastProcessAt !== undefined ? Math.max(0, lastProcessAt - firstProcessAt) : 0,
      availability: 'available',
    },
  }
}

function roundIndex(all = session.sessionManager.getEntries()) {
  const lastEntryId = all.length ? entryId(all.at(-1)) : undefined
  const leafId = session.sessionManager.getLeafId()
  const cached = roundIndexCache
  if (cached && cached.entryCount === all.length && cached.lastEntryId === lastEntryId && cached.leafId === leafId) return cached.rows

  const appendOnly = cached
    && cached.leafId === leafId
    && all.length >= cached.entryCount
    && (cached.entryCount === 0 || entryId(all[cached.entryCount - 1]) === cached.lastEntryId)
  const rows = appendOnly ? [...cached.rows] : []
  const entryPositions = appendOnly ? new Map(cached.entryPositions) : new Map()
  const roundByCursor = appendOnly ? new Map(cached.roundByCursor) : new Map()
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
    const row = {
      cursor,
      ordinal: rows.length + 1,
      entryIndex,
      ...(preview.trim() ? { preview: preview.replace(/\s+/g, ' ').trim().slice(0, 86) } : {}),
    }
    rows.push(row)
    roundByCursor.set(row.cursor, row)
  }

  const firstAffectedRound = appendOnly ? Math.max(0, cached.rows.length - 1) : 0
  for (let index = firstAffectedRound; index < rows.length; index += 1) {
    const row = rows[index]
    const nextEntryIndex = rows[index + 1]?.entryIndex ?? all.length
    row.summary = roundSummary(all, row, nextEntryIndex)
  }

  roundIndexCache = { entryCount: all.length, lastEntryId, leafId, rows, entryPositions, roundByCursor }
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
    ? roundIndexCache?.entryPositions?.get(cursor) ?? all.findIndex(entry => entryId(entry) === cursor)
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
    const row = roundIndexCache?.roundByCursor?.get(cursor)
    return {
      total: rows.length,
      items: row ? [{
        cursor: row.cursor,
        ordinal: row.ordinal,
        ...(row.preview ? { preview: row.preview } : {}),
        ...(row.summary ? { summary: row.summary } : {}),
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

function sessionTreePreview(entry) {
  const row = record(entry)
  if (row.type === 'message') {
    const message = record(row.message)
    const content = message.content ?? row.content
    const text = Array.isArray(content)
      ? content.map(part => typeof part === 'string'
        ? part
        : typeof record(part).text === 'string'
          ? String(record(part).text)
          : '').join(' ')
      : typeof content === 'string' ? content : ''
    return text.replace(/\s+/g, ' ').trim().slice(0, 120)
  }
  if (row.type === 'branch_summary' || row.type === 'compaction') {
    return typeof row.summary === 'string' ? row.summary.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  }
  if (row.type === 'custom_message') {
    const content = row.content
    const text = Array.isArray(content)
      ? content.map(part => typeof part === 'string' ? part : String(record(part).text ?? '')).join(' ')
      : typeof content === 'string' ? content : ''
    return text.replace(/\s+/g, ' ').trim().slice(0, 120)
  }
  return ''
}

function sessionTreeNodeType(entry) {
  const type = record(entry).type
  if (type === 'message') return 'message'
  if (type === 'branch_summary') return 'branch-summary'
  if (type === 'compaction') return 'compaction'
  if (type === 'model_change' || type === 'thinking_level_change' || type === 'session_info' || type === 'label') return 'control'
  if (type === 'custom' || type === 'custom_message') return 'custom'
  return 'other'
}

function sessionTree() {
  const manager = session?.sessionManager
  if (!manager || typeof manager.getTree !== 'function') {
    return {
      activeLeafId: manager?.getLeafId?.() ?? null,
      nodes: [],
      branchPointIds: [],
      capabilities: { switchBranch: false, fork: false, clone: false, branchSummary: false },
    }
  }

  const activePath = new Set(
    typeof manager.getBranch === 'function'
      ? manager.getBranch().map(entryId).filter(Boolean)
      : [],
  )
  const roots = manager.getTree()
  const nodes = []
  const branchPointIds = []
  const stack = Array.isArray(roots) ? [...roots].reverse() : []
  let branchSummarySupported = typeof manager.branchWithSummary === 'function'

  while (stack.length) {
    const node = record(stack.pop())
    const entry = record(node.entry)
    const id = entryId(entry)
    if (!id) continue
    const children = Array.isArray(node.children) ? node.children : []
    if (children.length > 1) branchPointIds.push(id)
    if (entry.type === 'branch_summary') branchSummarySupported = true

    const message = record(entry.message)
    const rawRole = typeof message.role === 'string' ? message.role : ''
    const role = rawRole === 'user' || rawRole === 'assistant' || rawRole === 'tool' || rawRole === 'system'
      ? rawRole
      : rawRole ? 'unknown' : undefined
    const preview = sessionTreePreview(entry)
    const label = typeof node.label === 'string' && node.label.trim() ? node.label.trim().slice(0, 120) : undefined
    const summary = entry.type === 'branch_summary' && typeof entry.summary === 'string'
      ? entry.summary.trim().slice(0, 500)
      : undefined

    nodes.push({
      id,
      parentId: typeof entry.parentId === 'string' && entry.parentId ? entry.parentId : null,
      type: sessionTreeNodeType(entry),
      ...(typeof entry.timestamp === 'string' ? { timestamp: entry.timestamp } : {}),
      ...(role ? { role } : {}),
      ...(preview ? { preview } : {}),
      ...(label ? { label } : {}),
      ...(summary ? { summary } : {}),
      activePath: activePath.has(id),
      childCount: children.length,
    })
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index])
  }

  return {
    activeLeafId: manager.getLeafId?.() ?? null,
    nodes,
    branchPointIds,
    capabilities: {
      switchBranch: capabilities?.treeNavigation === true,
      fork: capabilities?.messageFork === true,
      clone: false,
      branchSummary: branchSummarySupported,
    },
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
    ...(startupMetrics.length ? { startupMetrics } : {}),
    ...(warmWorkerStatus ? { warmWorkerStatus } : {}),
    ...(extensionBindingStatus ? { extensionBindingStatus } : {}),
    ...(extensionBindingError ? { extensionBindingError } : {}),
    ...(session?.sessionFile ? { sessionFile: session.sessionFile } : {}),
  }
}

async function initialize(input) {
  runtimeCwd = typeof input.cwd === 'string' ? input.cwd : ''
  initializationStartedAt = Date.now()
  currentInitializationStage = undefined
  currentStageStartedAt = initializationStartedAt
  initializationTimings = []
  startupMetrics = []
  const agentLensStartup = record(input.agentLensStartup)
  warmWorkerStatus = ['hit', 'miss', 'not_ready', 'sdk_mismatch'].includes(agentLensStartup.warmWorkerStatus)
    ? agentLensStartup.warmWorkerStatus
    : undefined
  for (const metric of prewarmMetrics) {
    if (typeof metric?.name === 'string' && typeof metric?.durationMs === 'number') {
      recordStartupMetric(metric.name, metric.durationMs, { prewarm: true })
    }
  }
  if (Array.isArray(agentLensStartup.metrics)) {
    for (const value of agentLensStartup.metrics) {
      const metric = record(value)
      if (typeof metric.name === 'string' && typeof metric.durationMs === 'number') {
        recordStartupMetric(metric.name, metric.durationMs)
      }
    }
  }
  packageUpdateCheck = 'checking'
  packageUpdates = []

  progress('loading_sdk', '正在加载 Pi SDK')
  const sdkWasLoaded = Boolean(sdk)
  const sdkStartedAt = Date.now()
  const loadedSdk = await loadSdk(record(input.sdk))
  recordStartupMetric('sdk_import_ms', sdkWasLoaded ? 0 : Date.now() - sdkStartedAt)

  const sessionManagerStartedAt = Date.now()
  const sessionManager = await createSessionManager(loadedSdk, input)
  recordStartupMetric('session_manager_ms', Date.now() - sessionManagerStartedAt)

  const hasSessionRuntime = ['createAgentSessionServices', 'createAgentSessionRuntime', 'createAgentSessionFromServices'].every(name => typeof loadedSdk[name] === 'function')
  if (hasSessionRuntime) {
    runtimeMode = 'session_runtime'
    const createdBaseMetric = await ensureBaseRuntime(loadedSdk)
    recordStartupMetric('model_runtime_create_ms', createdBaseMetric ? createdBaseMetric.durationMs : 0)
    const agentDir = baseAgentDir ?? loadedSdk.getAgentDir()
    const createRuntime = async options => {
      progress('loading_resources', '正在加载配置、扩展与上下文')
      let settingsManager
      const settingsStartedAt = Date.now()
      if (typeof loadedSdk.SettingsManager?.create === 'function') {
        settingsManager = loadedSdk.SettingsManager.create(options.cwd, options.agentDir)
      }
      recordStartupMetric('settings_manager_ms', Date.now() - settingsStartedAt)

      const resourcesStartedAt = Date.now()
      const services = await loadedSdk.createAgentSessionServices({
        cwd: options.cwd,
        agentDir: options.agentDir,
        ...(settingsManager ? { settingsManager } : {}),
        ...(baseModelRuntime
          ? { modelRuntime: baseModelRuntime }
          : { modelRuntimeSignal: AbortSignal.timeout(15_000) }),
      })
      recordStartupMetric('cwd_services_create_ms', Date.now() - resourcesStartedAt)
      const resources = startupResourceSnapshot(services.resourceLoader, input.cwd, services.diagnostics)
      publishStartupResources(resources)

      progress('creating_session', '正在创建 Pi Session')
      const sessionStartedAt = Date.now()
      const created = await loadedSdk.createAgentSessionFromServices({
        services,
        sessionManager: options.sessionManager,
        sessionStartEvent: options.sessionStartEvent,
      })
      recordStartupMetric('agent_session_create_ms', Date.now() - sessionStartedAt)
      return { ...created, services, diagnostics: services.diagnostics }
    }
    runtime = await loadedSdk.createAgentSessionRuntime(createRuntime, { cwd: input.cwd, agentDir, sessionManager })
    session = runtime.session
  } else {
    progress('loading_resources', '正在使用兼容模式加载 Pi 配置与扩展')
    progress('creating_session', '正在创建 Pi Session')
    const compatibilitySessionStartedAt = Date.now()
    const created = await loadedSdk.createAgentSession({ cwd: input.cwd, sessionManager })
    recordStartupMetric('agent_session_create_ms', Date.now() - compatibilitySessionStartedAt)
    const compatibilityLoader = record(created).resourceLoader ?? record(record(created).services).resourceLoader
    const compatibilityResources = startupResourceSnapshot(compatibilityLoader, input.cwd, record(created).diagnostics, record(created).extensionsResult)
    publishStartupResources(compatibilityResources)
    session = created.session
    runtime = { dispose: async () => session.dispose() }
  }
  capabilities = runtimeCapabilities(hasSessionRuntime)
  send('event', { type: 'runtime_capabilities', capabilities })
  extensionUi = createExtensionUi()
  unsubscribe = session.subscribe(event => send('event', wireEvent(event)))
  if (input.name) session.setSessionName(input.name)
  if (input.provider || input.model) await selectModel(input.provider, input.model)

  // Match Pi Web lifecycle semantics: Session Core becomes usable first;
  // extension session_start/resources_discover binding continues in background.
  progress('binding_extensions', '正在后台绑定扩展')
  beginExtensionBinding(input)
  recordStartupMetric('ready_ms', Math.max(0, Date.now() - initializationStartedAt))
  progress('ready', 'Pi Runtime 核心已就绪')
  // Package update IO waits until extension binding settles so it never competes
  // with the foreground-critical extension startup path.
  void extensionBindingPromise.finally(() => {
    if (!terminating) startPackageUpdateCheck(input.cwd)
  }).catch(() => undefined)
}

function beginExtensionBinding(input) {
  if (extensionBindingPromise) return extensionBindingPromise
  extensionBindingStatus = 'binding'
  extensionBindingError = undefined
  send('event', { type: 'runtime_extension_binding', status: 'binding' })
  const startedAt = Date.now()

  extensionBindingPromise = Promise.resolve().then(() => session.bindExtensions({
    uiContext: extensionUi.context,
    mode: 'rpc',
    abortHandler: () => { void session.abort() },
    onError: value => send('event', {
      type: 'extension_error',
      error: diagnostic(record(value).error ?? 'Unknown extension error'),
    }),
  })).then(() => {
    recordStartupMetric('extension_bind_ms', Date.now() - startedAt)
    extensionBindingStatus = 'ready'
    const finalResourceLoader = record(session).resourceLoader
    const finalResources = startupResourceSnapshot(finalResourceLoader, input.cwd)
    publishStartupResources(finalResources)
    send('event', { type: 'runtime_extension_binding', status: 'ready' })
  }).catch(error => {
    recordStartupMetric('extension_bind_ms', Date.now() - startedAt)
    extensionBindingStatus = 'failed'
    extensionBindingError = diagnostic(error instanceof Error ? error.message : error)
    send('event', {
      type: 'runtime_extension_binding',
      status: 'failed',
      error: extensionBindingError,
    })
    throw error
  })

  // Binding failure must remain observable but never become an unhandled Worker rejection.
  void extensionBindingPromise.catch(() => undefined)
  return extensionBindingPromise
}

async function waitForExtensionBinding() {
  if (!extensionBindingPromise) return
  await extensionBindingPromise
  if (extensionBindingStatus === 'failed') {
    throw new Error(extensionBindingError || 'Pi extension binding failed')
  }
}

function state() {
  return {
    runtimeSessionId, status: 'ready', initializationStage: 'ready', initializationMessage: `Pi Runtime 已就绪 · ${formatElapsed(handshakeDiagnostics().initializationElapsedMs)}`,
    ...handshakeDiagnostics(),
    sdkVersion, runtimeMode, nativeSessionId: session.sessionId, ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
    ...(session.sessionName ? { sessionName: session.sessionName } : {}), ...(session.model ? { model: session.model } : {}),
    thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming, isCompacting: session.isCompacting,
    pendingMessageCount: session.pendingMessageCount, leafId: session.sessionManager.getLeafId(), processId: process.pid,
    ...(extensionBindingStatus ? { extensionBindingStatus } : {}),
    ...(extensionBindingError ? { extensionBindingError } : {}),
    ...(currentStartupResources ? { startupResources: currentStartupResources } : {}),
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
  const needsExtensions = name === 'commands'
    || name === 'navigateTree'
    || name === 'setModel'
    || name === 'setThinkingLevel'
    || name === 'prompt'
    || name === 'steer'
    || name === 'followUp'
  if (needsExtensions) await waitForExtensionBinding()
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
  if (name === 'sessionTree') return sessionTree()
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
      prewarmMetrics = []
      const sdkStartedAt = Date.now()
      const loadedSdk = await loadSdk(record(record(envelope.payload).sdk))
      prewarmMetrics.push({ name: 'prewarm_sdk_import_ms', durationMs: Math.max(0, Date.now() - sdkStartedAt) })
      const baseMetric = await ensureBaseRuntime(loadedSdk)
      if (baseMetric) {
        prewarmMetrics.push({ name: 'prewarm_model_runtime_create_ms', durationMs: baseMetric.durationMs })
      } else if (baseModelRuntime) {
        prewarmMetrics.push({ name: 'prewarm_model_runtime_create_ms', durationMs: 0 })
      }
      send('response', { sdkVersion, prewarmMetrics }, envelope.requestId, true)
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
