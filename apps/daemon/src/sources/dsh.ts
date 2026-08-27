import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import * as zlib from 'node:zlib'
import type {
  DetectedSource,
  DiscoveredAsset,
  Disposable,
  EvidenceCandidate,
  NormalizedSourceOutput,
  ObservationCapability,
  ObservationCandidate,
  ObservationIdentityHints,
  SourceDefinition,
  SourceDetectionContext,
  SourceExecutionContext,
  SourceNormalizationContext,
  SourcePluginManifest,
  SourceRecord,
  SourceRecordEmitter,
} from '@agent-lens/core'
import { defineAgentLensPlugin, type AgentLensContext } from '@agent-lens/runtime-cordis'

const SOURCE_ID = 'dsh'
const PARSER_VERSION = '2'
const MAX_STRING = 64 * 1024
const RUNTIME_POLL_MS = 2000
const RUNTIME_DEBOUNCE_MS = 180
const PACKED_TAGS = new Set(['text-chunks', 'reasoning-chunks', 'usage-chunks', 'signature-chunks', 'tool-call-chunks'])
const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie)/i

type JsonObject = Record<string, unknown>

interface DshHeader extends JsonObject {
  sessionId?: string
  createdAt?: number
  cwd?: string
  parentSessionId?: string
  parentEventSeq?: number
}

interface DshEvent extends JsonObject {
  seq?: number
  type?: string
  time?: number
  data?: unknown
}

interface ParsedSession {
  path: string
  header: DshHeader
  events: DshEvent[]
}

interface DshFileCheckpoint {
  path: string
  size: number
  mtimeMs: number
}

interface DshEnvelope {
  event: DshEvent
  session: {
    nativeSessionId: string
    profile: string
    cwd?: string
    parentSessionId?: string
    parentEventSeq?: number
  }
  captureChannel: 'history' | 'native-tail'
}

interface ProfileManifest {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: string[]
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function stringField(record: JsonObject, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function numberField(record: JsonObject, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function truncate(value: string): string {
  return value.length <= MAX_STRING ? value : `${value.slice(0, MAX_STRING)}…[truncated]`
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[max-depth]'
  if (typeof value === 'string') return truncate(value)
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitize(item, depth + 1))
  if (typeof value !== 'object') return String(value)
  const result: JsonObject = {}
  for (const [key, item] of Object.entries(value as JsonObject)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitize(item, depth + 1)
  }
  return result
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

function normalizeTimestamp(value: unknown, fallback?: string): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value
    return new Date(millis).toISOString()
  }
  if (typeof value === 'string' && value) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return normalizeTimestamp(numeric, fallback)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return fallback
}

function dshHome(env: Readonly<Record<string, string | undefined>>): string {
  if (env.DSH_HOME?.trim()) return resolve(env.DSH_HOME.trim())
  if (env.XDG_DATA_HOME?.trim()) return join(resolve(env.XDG_DATA_HOME.trim()), 'dsh')
  return join(homedir(), '.local', 'share', 'dsh')
}

async function profileRoots(env: Readonly<Record<string, string | undefined>>): Promise<Array<{ profile: string; root: string }>> {
  const root = join(dshHome(env), 'profiles')
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }
  return entries.filter(entry => entry.isDirectory()).map(entry => ({ profile: entry.name, root: join(root, entry.name) }))
}

async function sessionFiles(profileRoot: string): Promise<string[]> {
  const root = join(profileRoot, 'sessions')
  if (!await exists(root)) return []
  const result: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && isSessionFile(path)) result.push(path)
    }
  }
  await walk(root)
  return result.sort()
}

function isSessionFile(path: string): boolean {
  return path.endsWith('.jsonl') || path.endsWith('.jsonl.zst')
}

function decodeSession(buffer: Buffer, path: string): string {
  if (!path.endsWith('.zst')) return buffer.toString('utf8')
  const decoder = (zlib as unknown as { zstdDecompressSync?: (input: Buffer) => Buffer }).zstdDecompressSync
  if (!decoder) throw new Error('当前 Node.js 不支持 Zstandard，无法读取 DSH 压缩会话')
  return decoder(buffer).toString('utf8')
}

export function parseDshJsonl(text: string, path = 'memory.jsonl'): ParsedSession | null {
  let header: DshHeader | null = null
  const events: DshEvent[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let row: unknown
    try { row = JSON.parse(line) } catch { continue }
    const object = asRecord(row)
    if (!header && stringField(object, 'sessionId')) {
      header = object as DshHeader
      continue
    }
    const tag = stringField(object, 'tag')
    if (tag && PACKED_TAGS.has(tag)) continue
    if (numberField(object, 'seq') !== undefined && stringField(object, 'type')) events.push(object as DshEvent)
  }
  return header ? { path, header, events } : null
}

async function readSession(path: string): Promise<ParsedSession | null> {
  return parseDshJsonl(decodeSession(await readFile(path), path), path)
}

export async function detectDsh(ctx: SourceDetectionContext): Promise<DetectedSource[]> {
  const env = ctx.env ?? process.env
  const detected: DetectedSource[] = []
  for (const profile of await profileRoots(env)) {
    const sessions = await sessionFiles(profile.root)
    const hasProfile = await exists(join(profile.root, 'package.json'))
    const hasConfig = await exists(join(profile.root, 'settings.yaml')) || await exists(join(profile.root, 'cordis.patch.yml'))
    if (!sessions.length && !hasProfile && !hasConfig) continue
    detected.push({
      sourceId: SOURCE_ID,
      productId: SOURCE_ID,
      configRoot: profile.root,
      dataRoot: profile.root,
      confidence: sessions.length || hasProfile ? 'exact' : 'high',
    })
  }
  return detected
}

function sessionIdentity(session: ParsedSession, ctx: SourceExecutionContext) {
  const nativeSessionId = stringField(session.header, 'sessionId') ?? basename(session.path).replace(/\.jsonl(?:\.zst)?$/, '')
  return {
    nativeSessionId,
    cwd: stringField(session.header, 'cwd'),
    parentSessionId: stringField(session.header, 'parentSessionId'),
    parentEventSeq: numberField(session.header, 'parentEventSeq'),
    profile: basename(ctx.installation.dataRoot ?? ctx.installation.configRoot ?? '') || 'default',
  }
}

function checkpointKey(nativeSessionId: string): string {
  return `session:${sha256(nativeSessionId).slice(0, 24)}`
}

function fileCheckpointKey(path: string): string {
  return `file:${sha256(path).slice(0, 24)}`
}

function eventRecord(
  session: ParsedSession,
  event: DshEvent,
  ctx: SourceExecutionContext,
  captureChannel: DshEnvelope['captureChannel'] = 'history',
): SourceRecord {
  const identity = sessionIdentity(session, ctx)
  const seq = numberField(event, 'seq') ?? 0
  const nativeType = stringField(event, 'type') ?? 'unknown'
  const capturedAt = new Date().toISOString()
  const occurredAt = normalizeTimestamp(event.time, normalizeTimestamp(session.header.createdAt, capturedAt)) ?? capturedAt
  const fingerprint = sha256(JSON.stringify([identity.nativeSessionId, seq, nativeType, event.data ?? null]))
  return {
    id: `dsh-${sha256(`${identity.nativeSessionId}:${seq}:${fingerprint}`).slice(0, 32)}`,
    sourceId: SOURCE_ID,
    installationId: ctx.installation.id,
    sourceSessionNativeId: identity.nativeSessionId,
    nativeType,
    nativeId: `${identity.nativeSessionId}:${seq}`,
    sourceSequence: seq * 10,
    occurredAt,
    capturedAt,
    locator: { kind: 'file', path: session.path, offset: seq },
    fingerprint,
    payload: {
      event: sanitize(event) as DshEvent,
      session: {
        nativeSessionId: identity.nativeSessionId,
        profile: identity.profile,
        ...(identity.cwd ? { cwd: identity.cwd } : {}),
        ...(identity.parentSessionId ? { parentSessionId: identity.parentSessionId } : {}),
        ...(identity.parentEventSeq === undefined ? {} : { parentEventSeq: identity.parentEventSeq }),
      },
      captureChannel,
    } satisfies DshEnvelope,
    parserVersion: PARSER_VERSION,
  }
}

export async function* ingestDshHistory(ctx: SourceExecutionContext): AsyncIterable<SourceRecord> {
  const root = ctx.installation.dataRoot
  if (!root || ctx.abortSignal.aborted) return
  for (const path of await sessionFiles(root)) {
    if (ctx.abortSignal.aborted) return
    const meta = await stat(path).catch(() => null)
    if (!meta) continue
    const fileKey = fileCheckpointKey(path)
    const previousFile = await ctx.checkpoint.get<DshFileCheckpoint>(fileKey)
    if (previousFile?.path === path && previousFile.size === meta.size && previousFile.mtimeMs === meta.mtimeMs) continue

    let session: ParsedSession | null = null
    try { session = await readSession(path) } catch { continue }
    if (!session) continue
    const identity = sessionIdentity(session, ctx)
    let after = await ctx.checkpoint.get<number>(checkpointKey(identity.nativeSessionId)) ?? -1
    for (const event of session.events) {
      const seq = numberField(event, 'seq') ?? 0
      if (seq <= after) continue
      yield eventRecord(session, event, ctx, 'history')
      after = seq
      await ctx.checkpoint.set(checkpointKey(identity.nativeSessionId), after)
    }
    await ctx.checkpoint.set(fileKey, { path, size: meta.size, mtimeMs: meta.mtimeMs })
  }
}

async function emitChangedSession(
  path: string,
  ctx: SourceExecutionContext,
  emitter: SourceRecordEmitter,
): Promise<void> {
  if (ctx.abortSignal.aborted || !isSessionFile(path) || !await exists(path)) return
  const before = await stat(path).catch(() => null)
  if (!before) return
  let session: ParsedSession | null = null
  try { session = await readSession(path) } catch { return }
  if (!session) return
  const identity = sessionIdentity(session, ctx)
  const key = checkpointKey(identity.nativeSessionId)
  let after = await ctx.checkpoint.get<number>(key) ?? -1
  for (const event of session.events) {
    if (ctx.abortSignal.aborted) return
    const seq = numberField(event, 'seq') ?? 0
    if (seq <= after) continue
    await emitter.emit(eventRecord(session, event, ctx, 'native-tail'))
    after = seq
    await ctx.checkpoint.set(key, after)
  }
  const afterMeta = await stat(path).catch(() => null)
  if (afterMeta && afterMeta.size === before.size && afterMeta.mtimeMs === before.mtimeMs) {
    await ctx.checkpoint.set(fileCheckpointKey(path), { path, size: before.size, mtimeMs: before.mtimeMs })
  }
}

export async function startDshRuntimeCapture(
  ctx: SourceExecutionContext,
  emitter: SourceRecordEmitter,
): Promise<Disposable> {
  const profileRoot = ctx.installation.dataRoot
  const sessionsRoot = profileRoot ? join(profileRoot, 'sessions') : ''
  if (!profileRoot || !await exists(sessionsRoot)) return { dispose() {} }

  let stopped = false
  let watcher: FSWatcher | null = null
  let pollTimer: NodeJS.Timeout | null = null
  const debounce = new Map<string, NodeJS.Timeout>()
  const mtimes = new Map<string, number>()

  const schedule = (path: string) => {
    if (stopped || !isSessionFile(path)) return
    const previous = debounce.get(path)
    if (previous) clearTimeout(previous)
    debounce.set(path, setTimeout(() => {
      debounce.delete(path)
      void emitChangedSession(path, ctx, emitter).catch(() => undefined)
    }, RUNTIME_DEBOUNCE_MS))
  }

  const poll = async () => {
    if (stopped || ctx.abortSignal.aborted) return
    for (const path of await sessionFiles(profileRoot)) {
      const meta = await stat(path).catch(() => null)
      if (!meta) continue
      const previous = mtimes.get(path)
      mtimes.set(path, meta.mtimeMs)
      if (previous !== undefined && previous !== meta.mtimeMs) schedule(path)
    }
  }

  try {
    watcher = watch(sessionsRoot, { recursive: true }, (_event, fileName) => {
      if (!fileName) return
      schedule(join(sessionsRoot, fileName.toString()))
    })
    watcher.on('error', () => {
      watcher?.close()
      watcher = null
    })
  } catch {
    watcher = null
  }

  if (!watcher) {
    await poll()
    pollTimer = setInterval(() => { void poll().catch(() => undefined) }, RUNTIME_POLL_MS)
  }

  return {
    dispose() {
      stopped = true
      watcher?.close()
      if (pollTimer) clearInterval(pollTimer)
      for (const timer of debounce.values()) clearTimeout(timer)
      debounce.clear()
    },
  }
}

async function readProfileManifest(root: string): Promise<ProfileManifest | null> {
  try {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as ProfileManifest
  } catch {
    return null
  }
}

function installedAsset(path: string, observedAt: string) {
  return [{ state: 'installed' as const, value: true as const, observedAt }]
}

export async function* discoverDshAssets(ctx: SourceExecutionContext): AsyncIterable<DiscoveredAsset> {
  const root = ctx.installation.configRoot ?? ctx.installation.dataRoot
  if (!root || ctx.abortSignal.aborted) return
  const manifestPath = join(root, 'package.json')
  const manifest = await readProfileManifest(root)
  const manifestMeta = await stat(manifestPath).catch(() => null)
  const observedAt = manifestMeta?.mtime.toISOString() ?? new Date().toISOString()
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest!.dsh!.profile!.bundles! : []

  for (const name of bundles) {
    if (ctx.abortSignal.aborted) return
    yield {
      definition: { type: 'plugin', canonicalName: name, displayName: name },
      binding: { path: manifestPath, source: 'dsh:bundle' },
      states: installedAsset(manifestPath, observedAt),
    }
  }

  const bundleSet = new Set(bundles)
  const dependencies = { ...(manifest?.dependencies ?? {}), ...(manifest?.devDependencies ?? {}) }
  for (const [name, version] of Object.entries(dependencies)) {
    if (ctx.abortSignal.aborted || bundleSet.has(name)) continue
    yield {
      definition: { type: 'plugin', canonicalName: name, displayName: name },
      binding: { path: join(root, 'node_modules', name), source: 'dsh:profile-plugin', version },
      states: installedAsset(manifestPath, observedAt),
    }
  }

  const patchPath = join(root, 'cordis.patch.yml')
  const patchMeta = await stat(patchPath).catch(() => null)
  if (patchMeta) {
    yield {
      definition: { type: 'rule', canonicalName: 'profile-config', displayName: 'Profile 配置覆盖' },
      binding: { path: patchPath, source: 'dsh:profile-config' },
      states: [{ state: 'configured', value: true, observedAt: patchMeta.mtime.toISOString() }],
    }
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return truncate(content)
  if (!Array.isArray(content)) return ''
  return truncate(content.map(part => {
    if (typeof part === 'string') return part
    const item = asRecord(part)
    return stringField(item, 'text', 'content') ?? ''
  }).filter(Boolean).join('\n'))
}

function evidenceFor(record: SourceRecord): EvidenceCandidate {
  const envelope = record.payload as DshEnvelope
  return {
    captureMethod: 'native-log',
    derivation: envelope.captureChannel === 'native-tail' ? 'observed' : 'reported',
    sourceRecordId: record.id,
    sourceLocator: record.locator,
    parserVersion: record.parserVersion,
    ...(record.nativeId ? { nativeStableId: record.nativeId } : {}),
    ...(record.occurredAt ? { eventTime: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    confidenceHint: 'exact',
  }
}

function identity(_record: SourceRecord, envelope: DshEnvelope): ObservationIdentityHints {
  return {
    nativeSessionId: envelope.session.nativeSessionId,
    ...(envelope.session.parentSessionId ? { nativeParentSessionId: envelope.session.parentSessionId } : {}),
    ...(envelope.session.cwd ? { workspacePath: envelope.session.cwd } : {}),
  }
}

function candidate(record: SourceRecord, envelope: DshEnvelope, kind: ObservationCandidate['kind'], payload: unknown, options: { offset?: number; nativeCallId?: string } = {}): ObservationCandidate {
  const offset = options.offset ?? 0
  const nativeCallId = options.nativeCallId
  return {
    kind,
    ...(nativeCallId ? { nativeCallId } : {}),
    ...(!nativeCallId && record.nativeId ? { nativeEventId: record.nativeId } : {}),
    ...(record.sourceSequence === undefined ? {} : { sourceSequence: record.sourceSequence + offset }),
    ...(record.occurredAt ? { occurredAt: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    payload,
    identityHints: identity(record, envelope),
    dedupHints: {
      ...(nativeCallId ? { nativeCallId } : {}),
      ...(!nativeCallId && record.nativeId ? { nativeEventId: record.nativeId } : {}),
      ...(record.sourceSequence === undefined ? {} : { sourceSequence: record.sourceSequence + offset }),
      ...(record.fingerprint ? { payloadFingerprint: record.fingerprint } : {}),
    },
  }
}

function usageData(data: JsonObject): JsonObject | null {
  const usage = asRecord(data.usage)
  const inputTokens = numberField(usage, 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens')
  const outputTokens = numberField(usage, 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens')
  const cacheReadTokens = numberField(usage, 'cacheReadTokens', 'cache_read_tokens', 'cachedTokens', 'cached_tokens')
  const cacheWriteTokens = numberField(usage, 'cacheWriteTokens', 'cache_write_tokens')
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every(value => value === undefined)) return null
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
  }
}

export async function normalizeDshRecord(record: SourceRecord, _ctx: SourceNormalizationContext): Promise<NormalizedSourceOutput> {
  const envelope = record.payload as DshEnvelope
  const event = asRecord(envelope.event)
  const data = asRecord(event.data)
  const type = stringField(event, 'type') ?? record.nativeType
  const observations: ObservationCandidate[] = []

  if (type === 'user/message') {
    observations.push(candidate(record, envelope, 'message.user', { text: textFromContent(data.content ?? data.message ?? data.text) }))
  } else if (type === 'assistant/message') {
    const model = stringField(data, 'model', 'modelId')
    observations.push(candidate(record, envelope, 'message.assistant', {
      text: textFromContent(data.content ?? data.message ?? data.text),
      ...(model ? { model } : {}),
    }))
    const usage = usageData(data)
    if (usage) observations.push(candidate(record, envelope, 'usage', usage, { offset: 1 }))
  } else if (type === 'tool/call') {
    const callId = stringField(data, 'id', 'toolCallId', 'callId') ?? `dsh-call-${record.id}`
    observations.push(candidate(record, envelope, 'tool.call', {
      callId,
      nativeToolName: stringField(data, 'name', 'toolName', 'tool') ?? 'unknown',
      input: sanitize(data.arguments ?? data.input ?? data.params ?? {}),
    }, { nativeCallId: callId }))
  } else if (type === 'tool/result') {
    const callId = stringField(data, 'id', 'toolCallId', 'callId') ?? `dsh-result-${record.id}`
    observations.push(candidate(record, envelope, 'tool.result', {
      callId,
      nativeToolName: stringField(data, 'name', 'toolName', 'tool') ?? 'unknown',
      success: !(data.isError === true || data.error != null),
      output: sanitize(data.result ?? data.output ?? data.content ?? data),
      ...(data.error != null ? { error: sanitize(data.error) } : {}),
    }, { nativeCallId: callId }))
  } else if (type === 'request/header') {
    observations.push(candidate(record, envelope, 'model.call', {
      provider: stringField(data, 'providerName', 'provider'),
      model: stringField(data, 'model', 'modelId'),
      systemPrompt: sanitize(data.systemPrompt),
      tools: sanitize(data.tools),
      request: sanitize(data),
    }))
  } else if (type === 'turn/start' || type === 'turn/end' || type === 'step/start' || type === 'step/end') {
    observations.push(candidate(record, envelope, 'session.lifecycle', {
      event: type.replace('/', '.'),
      data: sanitize(data),
      parentSessionId: envelope.session.parentSessionId,
      parentEventSeq: envelope.session.parentEventSeq,
    }))
  } else {
    observations.push(candidate(record, envelope, 'unknown', { rawType: type, rawPayload: sanitize(data) }))
  }

  return { observations, evidenceCandidates: [evidenceFor(record)] }
}

export async function declareDshCapabilities(_detected: DetectedSource): Promise<ObservationCapability[]> {
  return [
    { sourceId: SOURCE_ID, name: 'session', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'transcript', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'tool-call', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'tool-result', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'usage', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: SOURCE_ID, name: 'context', status: 'partial', captureModes: ['history', 'native-tail'], reason: 'request/header 可作为模型请求上下文证据；压缩 assistant/chunk 暂不展开' },
    { sourceId: SOURCE_ID, name: 'permission', status: 'unavailable', captureModes: [], reason: '当前 SessionEventMap 没有稳定权限事件映射' },
    { sourceId: SOURCE_ID, name: 'subagent', status: 'partial', captureModes: ['history', 'native-tail'], reason: 'SessionHeader lineage 已进入 SourceSession.nativeParentSessionId；关系类型仍保持保守，不把所有父子会话强行判定为 subagent' },
    { sourceId: SOURCE_ID, name: 'asset-discovery', status: 'available', captureModes: ['static-scan'] },
    { sourceId: SOURCE_ID, name: 'thinking', status: 'unavailable', captureModes: [], reason: '不展开压缩 reasoning chunk' },
    { sourceId: SOURCE_ID, name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: '尚未建立 DSH 工具到 Bundle/Plugin 资产的稳定调用归因' },
    { sourceId: SOURCE_ID, name: 'artifact-action', status: 'unavailable', captureModes: [], reason: '尚未建立稳定 artifact 映射' },
  ]
}

export const dshManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-dsh',
  pluginVersion: '1.0.0-alpha.1',
  apiVersion: '1.0',
  pluginType: 'source',
  displayName: 'DeepSeek Harness Source',
  sourceId: SOURCE_ID,
  productId: SOURCE_ID,
  parserVersion: PARSER_VERSION,
}

export const dshSourceDefinition: SourceDefinition = {
  manifest: dshManifest,
  detect: detectDsh,
  declareCapabilities: declareDshCapabilities,
  discoverAssets: discoverDshAssets,
  ingestHistory: ingestDshHistory,
  startCapture: startDshRuntimeCapture,
  normalize: normalizeDshRecord,
}

const applyDshSource = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.sources.register(dshSourceDefinition)
    return () => registration.dispose()
  },
  { inject: ['sources'] },
)

export const dshSourcePlugin = defineAgentLensPlugin(dshManifest, applyDshSource)

export const dshSourceInternals = {
  dshHome,
  profileRoots,
  sessionFiles,
  parseDshJsonl,
  normalizeTimestamp,
  readProfileManifest,
  checkpointKey,
}
