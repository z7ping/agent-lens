import { randomUUID } from 'node:crypto'
import { access, readFile, realpath } from 'node:fs/promises'
import { basename, delimiter, dirname, extname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { serialize } from 'node:v8'

const VERSION = 1
const MAX_MESSAGE_BYTES = 1024 * 1024
const MAX_OUTBOUND_MESSAGES = 256
const MAX_SEEN_REQUEST_IDS = 512
let runtimeSessionId = ''
let runtime
let session
let unsubscribe = () => {}
let extensionUi
let terminating = false
let sdkVersion
let runtimeMode = 'compatibility'
let capabilities
let initializationStartedAt = 0
let currentInitializationStage
let currentStageStartedAt = 0
let initializationTimings = []
const seenRequestIds = new Set()
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

function startupResourceSnapshot(resourceLoader, cwd, extraDiagnostics, fallbackExtensions) {
  const loader = resourceLoader && typeof resourceLoader === 'object' ? resourceLoader : undefined
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
  if (!process.send || !runtimeSessionId) return false
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

async function findExecutable(explicit) {
  if (explicit && await exists(explicit)) return explicit
  const configured = process.env.PI_BIN?.trim()
  if (configured && await exists(configured)) return configured
  const names = process.platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi.bat'] : ['pi']
  for (const root of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(root, name)
      if (await exists(candidate)) return candidate
    }
  }
  throw new Error('Pi executable was not found in PATH or PI_BIN')
}

async function shimEntry(executable) {
  const source = await readFile(executable, 'utf8')
  for (const match of source.matchAll(/%(?:~dp0|dp0%)([^"\r\n]*?\.(?:mjs|cjs|js))/ig)) {
    const suffix = match[1]
    if (!suffix) continue
    const candidate = resolve(dirname(executable), suffix.replace(/^[\\/]+/, '').replace(/[\\/]/g, process.platform === 'win32' ? '\\' : '/'))
    if (await exists(candidate)) return candidate
  }
}

async function sdkEntryFor(executable) {
  const extension = extname(executable).toLowerCase()
  let entry = executable
  if (process.platform === 'win32' && (extension === '.cmd' || extension === '.bat')) entry = await shimEntry(executable)
  else entry = await realpath(executable).catch(() => resolve(executable))
  if (!entry) throw new Error(`Pi SDK could not be located from ${executable}`)
  let cursor = dirname(entry)
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(cursor, 'package.json'), 'utf8'))
      if (manifest.name === '@earendil-works/pi-coding-agent') {
        const sdkEntry = resolve(cursor, typeof manifest.main === 'string' ? manifest.main : './dist/index.js')
        if (!await exists(sdkEntry)) throw new Error(`Pi SDK entry does not exist: ${sdkEntry}`)
        return { sdkEntry, version: typeof manifest.version === 'string' ? manifest.version : undefined }
      }
    } catch (error) {
      if (error instanceof SyntaxError || String(error?.message ?? '').startsWith('Pi SDK entry')) throw error
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  throw new Error(`Official Pi SDK package could not be located from ${executable}`)
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
    thinkingLevelControl: typeof session?.setThinkingLevel === 'function',
    extensionUi: typeof session?.bindExtensions === 'function',
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
  initializationStartedAt = Date.now()
  currentInitializationStage = undefined
  currentStageStartedAt = initializationStartedAt
  initializationTimings = []
  progress('loading_sdk', '正在加载 Pi SDK')
  const executable = await findExecutable(input.executable)
  const discovery = await sdkEntryFor(executable)
  sdkVersion = discovery.version
  const sdk = await import(pathToFileURL(discovery.sdkEntry).href)
  if (typeof sdk.createAgentSession !== 'function' || !sdk.SessionManager) throw new Error('Installed Pi SDK is missing required AgentSession capabilities')
  const sessionManager = input.sessionPath ? sdk.SessionManager.open(input.sessionPath, input.sessionDir, input.cwd) : sdk.SessionManager.create(input.cwd, input.sessionDir)
  const hasSessionRuntime = ['createAgentSessionServices', 'createAgentSessionRuntime', 'createAgentSessionFromServices'].every(name => typeof sdk[name] === 'function')
  if (hasSessionRuntime) {
    runtimeMode = 'session_runtime'
    const agentDir = sdk.getAgentDir()
    const createRuntime = async options => {
      progress('loading_resources', '正在加载配置、扩展与上下文')
      const services = await sdk.createAgentSessionServices({ cwd: options.cwd, agentDir: options.agentDir, modelRuntimeSignal: AbortSignal.timeout(15_000) })
      send('event', { type: 'runtime_resources', resources: startupResourceSnapshot(services.resourceLoader, input.cwd, services.diagnostics) })
      progress('creating_session', '正在创建 Pi Session')
      const created = await sdk.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent })
      return { ...created, services, diagnostics: services.diagnostics }
    }
    runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd: input.cwd, agentDir, sessionManager })
    session = runtime.session
  } else {
    progress('loading_resources', '正在使用兼容模式加载 Pi 配置与扩展')
    progress('creating_session', '正在创建 Pi Session')
    const created = await sdk.createAgentSession({ cwd: input.cwd, sessionManager })
    const compatibilityLoader = record(created).resourceLoader ?? record(record(created).services).resourceLoader
    const compatibilityResources = startupResourceSnapshot(compatibilityLoader, input.cwd, record(created).diagnostics, record(created).extensionsResult)
    if (Object.values(compatibilityResources).some(value => Array.isArray(value) && value.length)) {
      send('event', { type: 'runtime_resources', resources: compatibilityResources })
    }
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
  if (input.name) session.setSessionName(input.name)
  if (input.provider || input.model) await selectModel(input.provider, input.model)
  progress('ready', 'Pi Runtime 已就绪')
}

function state() {
  return {
    runtimeSessionId, status: 'ready', initializationStage: 'ready', initializationMessage: `Pi Runtime 已就绪 · ${formatElapsed(handshakeDiagnostics().initializationElapsedMs)}`,
    ...handshakeDiagnostics(),
    sdkVersion, runtimeMode, nativeSessionId: session.sessionId, ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
    ...(session.sessionName ? { sessionName: session.sessionName } : {}), ...(session.model ? { model: session.model } : {}),
    thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming, isCompacting: session.isCompacting,
    pendingMessageCount: session.pendingMessageCount, leafId: session.sessionManager.getLeafId(), processId: process.pid,
  }
}

async function models(provider) {
  const snapshot = session.modelRuntime.getAvailableSnapshot()
  const filtered = provider ? snapshot.filter(model => model.provider === provider) : snapshot
  return filtered.length ? filtered : await session.modelRuntime.getAvailable(provider)
}

async function selectModel(provider, modelId) {
  const available = await models(provider)
  const model = available.find(item => (!provider || item.provider === provider) && (!modelId || item.id === modelId || item.name === modelId))
  if (!model) throw new Error(`Pi model is not available: ${[provider, modelId].filter(Boolean).join('/') || 'requested model'}`)
  await session.setModel(model)
}

async function command(name, value = {}) {
  if (!session && name !== 'terminate') throw new Error('Pi Runtime is not ready')
  if (name === 'state') return state()
  if (name === 'snapshot') {
    const all = session.sessionManager.getEntries()
    const index = value.since ? all.findIndex(entry => record(entry).id === value.since) : -1
    const entries = value.since && index >= 0 ? all.slice(index + 1) : all
    return { state: state(), entries, leafId: session.sessionManager.getLeafId() }
  }
  if (name === 'controls') return { models: (await models()).map(({ provider, id, name, reasoning }) => ({ provider, id, ...(name ? { name } : {}), ...(typeof reasoning === 'boolean' ? { reasoning } : {}) })), thinkingLevels: session.getAvailableThinkingLevels() }
  if (name === 'setModel') { await selectModel(value.provider, value.modelId); return state() }
  if (name === 'setThinkingLevel') { session.setThinkingLevel(value.level); return state() }
  if (name === 'prompt') {
    await new Promise((resolveAccepted, rejectAccepted) => {
      let accepted = false
      const accept = () => { if (!accepted) { accepted = true; resolveAccepted() } }
      void session.prompt(value.message, { ...(value.behavior ? { streamingBehavior: value.behavior } : {}), source: 'rpc', preflightResult: success => { if (success) accept() } }).then(accept, error => accepted ? undefined : rejectAccepted(error))
    })
    return
  }
  if (name === 'steer') return await session.steer(value.message)
  if (name === 'followUp') return await session.followUp(value.message)
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
  unsubscribe()
  extensionUi?.dispose()
  if (session?.isStreaming) { session.abortBash?.(); await session.abort().catch(() => undefined) }
  await runtime?.dispose()
}

process.on('message', async value => {
  const envelope = record(value)
  if (envelope.version !== VERSION || typeof envelope.runtimeSessionId !== 'string') return
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
