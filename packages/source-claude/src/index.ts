import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  mkdir,
  opendir,
  readFile,
  readdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  delimiter,
  dirname,
  extname,
  join,
} from 'node:path'
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
import {
  defineAgentLensPlugin,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'

const SOURCE_ID = 'claude-code'
const PARSER_VERSION = '1'
const MAX_STRING = 64 * 1024
const RUNTIME_POLL_MS = 250
const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie)/i

interface ClaudeSessionMetadata {
  nativeSessionId: string
  cwd?: string
}

interface ClaudeStoredEnvelope {
  entry: Record<string, unknown>
  session: ClaudeSessionMetadata
}

interface HistoryCheckpoint {
  path: string
  offset: number
  sequence: number
  size: number
  mtimeMs: number
}

interface JsonlLine {
  text: string
  startOffset: number
  endOffset: number
}

interface RuntimeInboxEnvelope {
  id: string
  capturedAt: string
  event: Record<string, unknown>
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function truncate(value: string, limit = MAX_STRING): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[max-depth]'
  if (typeof value === 'string') return truncate(value)
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitize(item, depth + 1))
  if (typeof value !== 'object') return String(value)

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitize(item, depth + 1)
  }
  return result
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findExecutable(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const explicit = env.CLAUDE_BIN?.trim()
  if (explicit && await exists(explicit)) return explicit

  const pathValue = env.PATH ?? process.env.PATH ?? ''
  const names = process.platform === 'win32'
    ? ['claude.exe', 'claude.cmd', 'claude.bat']
    : ['claude']
  for (const root of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(root, name)
      if (await exists(candidate)) return candidate
    }
  }
  return undefined
}

function claudeHome(env: Readonly<Record<string, string | undefined>>): string {
  return env.CLAUDE_CODE_HOME?.trim() || join(homedir(), '.claude')
}

export async function detectClaudeCode(
  ctx: SourceDetectionContext,
): Promise<DetectedSource[]> {
  const env = ctx.env ?? process.env
  const home = claudeHome(env)
  const projectsDir = join(home, 'projects')
  const [homeExists, projectsExist, executable] = await Promise.all([
    exists(home),
    exists(projectsDir),
    findExecutable(env),
  ])
  if (!homeExists && !projectsExist && !executable) return []

  return [{
    sourceId: SOURCE_ID,
    productId: SOURCE_ID,
    ...(executable ? { executable } : {}),
    configRoot: home,
    dataRoot: projectsDir,
    confidence: executable && projectsExist ? 'exact' : 'high',
  }]
}

async function* walkJsonlFiles(root: string): AsyncIterable<string> {
  let directory
  try {
    directory = await opendir(root)
  } catch {
    return
  }

  for await (const entry of directory) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* walkJsonlFiles(path)
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.jsonl') yield path
  }
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for await (const file of walkJsonlFiles(root)) files.push(file)
  return files.sort((a, b) => a.localeCompare(b))
}

async function* readJsonlLines(filePath: string, startOffset: number): AsyncIterable<JsonlLine> {
  const stream = createReadStream(filePath, { start: startOffset })
  let carry = Buffer.alloc(0)
  let carryOffset = startOffset

  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
    const dataOffset = carryOffset
    let cursor = 0

    while (true) {
      const newline = data.indexOf(0x0a, cursor)
      if (newline < 0) break
      let line = data.subarray(cursor, newline)
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1)
      yield {
        text: line.toString('utf8'),
        startOffset: dataOffset + cursor,
        endOffset: dataOffset + newline + 1,
      }
      cursor = newline + 1
    }

    carry = data.subarray(cursor)
    carryOffset = dataOffset + cursor
  }

  if (carry.length) {
    yield {
      text: carry.toString('utf8'),
      startOffset: carryOffset,
      endOffset: carryOffset + carry.length,
    }
  }
}

function parseHistoryLine(text: string): Record<string, unknown> {
  try {
    return asRecord(sanitize(JSON.parse(text)))
  } catch {
    return { type: 'malformed-json', raw: truncate(text, 16 * 1024) }
  }
}

function nativeSessionId(entry: Record<string, unknown>, filePath: string): string {
  return stringField(entry, 'sessionId', 'session_id')
    ?? basename(filePath, extname(filePath))
}

function nativeEntryId(entry: Record<string, unknown>): string | undefined {
  return stringField(entry, 'uuid', 'id', 'messageId', 'message_id')
}

function historyCheckpointKey(filePath: string): string {
  return `claude:history:${sha256(filePath)}`
}

export async function* ingestClaudeHistory(
  ctx: SourceExecutionContext,
): AsyncIterable<SourceRecord> {
  const projectsDir = ctx.installation.dataRoot
    ?? (ctx.installation.configRoot ? join(ctx.installation.configRoot, 'projects') : undefined)
  if (!projectsDir) return

  for (const filePath of await listJsonlFiles(projectsDir)) {
    if (ctx.abortSignal.aborted) return
    const fileStat = await stat(filePath)
    const key = historyCheckpointKey(filePath)
    const previous = await ctx.checkpoint.get<HistoryCheckpoint>(key)
    const unchanged = previous
      && previous.path === filePath
      && previous.offset === fileStat.size
      && previous.size === fileStat.size
      && previous.mtimeMs === fileStat.mtimeMs
    if (unchanged) continue

    const reset = !previous || previous.path !== filePath || fileStat.size < previous.offset
    let offset = reset ? 0 : previous.offset
    let sequence = reset ? 0 : previous.sequence
    let lastCwd: string | undefined

    for await (const line of readJsonlLines(filePath, offset)) {
      if (ctx.abortSignal.aborted) return
      sequence += 1
      offset = line.endOffset
      if (!line.text.trim()) {
        await ctx.checkpoint.set(key, {
          path: filePath,
          offset,
          sequence,
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
        })
        continue
      }

      const entry = parseHistoryLine(line.text)
      const cwd = stringField(entry, 'cwd') ?? lastCwd
      if (cwd) lastCwd = cwd
      const sessionId = nativeSessionId(entry, filePath)
      const nativeId = nativeEntryId(entry)
      const fingerprint = sha256(line.text)
      const timestamp = stringField(entry, 'timestamp', 'ts')
      const envelope: ClaudeStoredEnvelope = {
        entry,
        session: {
          nativeSessionId: sessionId,
          ...(cwd ? { cwd } : {}),
        },
      }
      const record: SourceRecord = {
        id: `claude-record-${sha256(`${filePath}|${line.startOffset}|${fingerprint}`).slice(0, 32)}`,
        sourceId: SOURCE_ID,
        installationId: ctx.installation.id,
        sourceSessionNativeId: sessionId,
        nativeType: `history/${stringField(entry, 'type') ?? 'unknown'}`,
        ...(nativeId ? { nativeId } : {}),
        sourceSequence: sequence,
        ...(timestamp ? { occurredAt: timestamp } : {}),
        capturedAt: new Date().toISOString(),
        locator: { kind: 'file', path: filePath, offset: line.startOffset },
        fingerprint,
        payload: envelope,
        parserVersion: PARSER_VERSION,
      }

      yield record
      await ctx.checkpoint.set(key, {
        path: filePath,
        offset,
        sequence,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      })
    }
  }
}

function runtimeInboxDirectory(): string {
  return process.env.AGENT_LENS_CLAUDE_INBOX
    ?? join(homedir(), '.agent-lens', '1.0', 'inbox', SOURCE_ID)
}

function runtimeEventName(event: Record<string, unknown>): string {
  return stringField(event, 'hook_event_name', 'event_name', 'type') ?? 'UnknownHookEvent'
}

function runtimeNativeId(event: Record<string, unknown>): string | undefined {
  const name = runtimeEventName(event)
  if (name === 'PreToolUse' || name === 'PostToolUse') {
    return stringField(event, 'tool_use_id', 'call_id')
  }
  return stringField(event, 'source_event_id', 'hook_invocation_id', 'turn_id', 'agent_id')
}

function parseRuntimeEnvelope(text: string, fileName: string): RuntimeInboxEnvelope {
  try {
    const parsed = asRecord(JSON.parse(text))
    return {
      id: stringField(parsed, 'id') ?? fileName,
      capturedAt: stringField(parsed, 'capturedAt') ?? new Date().toISOString(),
      event: asRecord(sanitize(parsed.event)),
    }
  } catch {
    return {
      id: fileName,
      capturedAt: new Date().toISOString(),
      event: { hook_event_name: 'MalformedInboxEvent', raw: truncate(text, 16 * 1024) },
    }
  }
}

function runtimeRecord(
  envelope: RuntimeInboxEnvelope,
  filePath: string,
  ctx: SourceExecutionContext,
): SourceRecord {
  const event = envelope.event
  const sessionId = stringField(event, 'session_id', 'sessionId') ?? 'runtime-unknown'
  const hookName = runtimeEventName(event)
  const nativeId = runtimeNativeId(event)
  const cwd = stringField(event, 'cwd', 'working_directory')
  const occurredAt = stringField(event, 'timestamp', 'ts') ?? envelope.capturedAt
  return {
    id: `claude-runtime-${sha256(envelope.id).slice(0, 32)}`,
    sourceId: SOURCE_ID,
    installationId: ctx.installation.id,
    sourceSessionNativeId: sessionId,
    nativeType: `hook/${hookName}`,
    ...(nativeId ? { nativeId } : {}),
    occurredAt,
    capturedAt: envelope.capturedAt,
    locator: { kind: 'runtime-hook', path: filePath, hookEventId: envelope.id },
    fingerprint: sha256(JSON.stringify(event)),
    payload: {
      runtimeEvent: event,
      session: {
        nativeSessionId: sessionId,
        ...(cwd ? { cwd } : {}),
      },
    },
    parserVersion: PARSER_VERSION,
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export async function startClaudeRuntimeCapture(
  ctx: SourceExecutionContext,
  emitter: SourceRecordEmitter,
): Promise<Disposable> {
  const inbox = runtimeInboxDirectory()
  await mkdir(inbox, { recursive: true })
  let stopped = false

  const task = (async () => {
    while (!stopped && !ctx.abortSignal.aborted) {
      let files: string[] = []
      try {
        files = (await readdir(inbox)).filter(name => name.endsWith('.json')).sort()
      } catch {
        files = []
      }

      for (const fileName of files) {
        if (stopped || ctx.abortSignal.aborted) break
        const filePath = join(inbox, fileName)
        try {
          const envelope = parseRuntimeEnvelope(await readFile(filePath, 'utf8'), fileName)
          await emitter.emit(runtimeRecord(envelope, filePath, ctx))
          await unlink(filePath)
        } catch {
          break
        }
      }
      if (!stopped && !ctx.abortSignal.aborted) await sleep(RUNTIME_POLL_MS, ctx.abortSignal)
    }
  })()

  return {
    async dispose(): Promise<void> {
      if (stopped) return
      stopped = true
      await task
    },
  }
}

async function safeStat(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

async function safeEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

async function* walkNamedFile(
  root: string,
  fileName: string,
  depth = 0,
  maxDepth = 8,
): AsyncIterable<string> {
  if (depth > maxDepth) return
  for (const entry of await safeEntries(root)) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* walkNamedFile(path, fileName, depth + 1, maxDepth)
    else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) yield path
  }
}

function staticEvidence(
  path: string,
  observedAt: string,
  capturedAt: string,
  nativeStableId: string,
): EvidenceCandidate {
  return {
    captureMethod: 'static-scan',
    derivation: 'observed',
    sourceLocator: { kind: 'file', path },
    nativeStableId,
    eventTime: observedAt,
    capturedAt,
    confidenceHint: 'exact',
  }
}

function assetStates(
  path: string,
  observedAt: string,
  capturedAt: string,
  nativeStableId: string,
  values: Array<{
    state: 'installed' | 'configured' | 'enabled' | 'discoverable'
    value: boolean | 'unknown'
  }>,
): NonNullable<DiscoveredAsset['states']> {
  const evidence = staticEvidence(path, observedAt, capturedAt, nativeStableId)
  return values.map(value => ({ ...value, observedAt, evidenceCandidates: [evidence] }))
}

async function* discoverSkillAssets(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  for await (const skillFile of walkNamedFile(join(configRoot, 'skills'), 'SKILL.md')) {
    const meta = await safeStat(skillFile)
    if (!meta?.isFile()) continue
    const skillDir = dirname(skillFile)
    const name = basename(skillDir)
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: { type: 'skill', canonicalName: name, displayName: name },
      binding: { path: skillDir, source: 'claude:skills' },
      states: assetStates(
        skillFile,
        observedAt,
        capturedAt,
        `skill:${skillFile}`,
        [
          { state: 'installed', value: true },
          { state: 'discoverable', value: true },
        ],
      ),
    }
  }
}

async function* discoverCommandAssets(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const commandsRoot = join(configRoot, 'commands')
  for (const entry of await safeEntries(commandsRoot)) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue
    const filePath = join(commandsRoot, entry.name)
    const meta = await safeStat(filePath)
    if (!meta?.isFile()) continue
    const name = basename(entry.name, extname(entry.name))
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: { type: 'builtin', canonicalName: `command:${name}`, displayName: name },
      binding: { path: filePath, source: 'claude:commands' },
      states: assetStates(
        filePath,
        observedAt,
        capturedAt,
        `command:${filePath}`,
        [
          { state: 'configured', value: true },
          { state: 'discoverable', value: true },
        ],
      ),
    }
  }
}

async function* discoverPluginAssets(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const root = join(configRoot, 'plugins')
  for (const entry of await safeEntries(root)) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    const meta = await safeStat(path)
    if (!meta) continue
    const observedAt = meta.mtime.toISOString()
    yield {
      definition: { type: 'plugin', canonicalName: entry.name, displayName: entry.name },
      binding: { path, source: 'claude:plugins' },
      states: assetStates(
        path,
        observedAt,
        capturedAt,
        `plugin:${path}`,
        [{ state: 'installed', value: true }],
      ),
    }
  }
}

async function* discoverSettingsAssets(
  configRoot: string,
  capturedAt: string,
): AsyncIterable<DiscoveredAsset> {
  const settingsFiles = [join(configRoot, 'settings.json')]
  if (configRoot === join(homedir(), '.claude')) settingsFiles.push(join(homedir(), '.claude.json'))

  for (const settingsPath of settingsFiles) {
    const meta = await safeStat(settingsPath)
    if (!meta?.isFile()) continue
    let settings: Record<string, unknown>
    try {
      settings = asRecord(JSON.parse(await readFile(settingsPath, 'utf8')))
    } catch {
      continue
    }
    const observedAt = meta.mtime.toISOString()
    const mcp = asRecord(settings.mcpServers ?? settings.mcp_servers)
    for (const name of Object.keys(mcp)) {
      yield {
        definition: { type: 'mcp', canonicalName: name, displayName: name },
        binding: { path: settingsPath, source: 'claude:settings' },
        states: assetStates(
          settingsPath,
          observedAt,
          capturedAt,
          `mcp:${settingsPath}:${name}`,
          [
            { state: 'configured', value: true },
            { state: 'discoverable', value: true },
          ],
        ),
      }
    }

    const hooks = asRecord(settings.hooks)
    for (const [eventName, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups) || groups.length === 0) continue
      yield {
        definition: {
          type: 'hook',
          canonicalName: `claude-hook:${eventName}`,
          displayName: `${eventName} Hook`,
        },
        binding: { path: settingsPath, source: 'claude:settings' },
        states: assetStates(
          settingsPath,
          observedAt,
          capturedAt,
          `hook:${settingsPath}:${eventName}`,
          [
            { state: 'configured', value: true },
            { state: 'enabled', value: true },
          ],
        ),
      }
    }
  }
}

export async function* discoverClaudeAssets(
  ctx: SourceExecutionContext,
): AsyncIterable<DiscoveredAsset> {
  const configRoot = ctx.installation.configRoot
  if (!configRoot || ctx.abortSignal.aborted) return
  const capturedAt = new Date().toISOString()
  const groups = [
    discoverSkillAssets(configRoot, capturedAt),
    discoverCommandAssets(configRoot, capturedAt),
    discoverPluginAssets(configRoot, capturedAt),
    discoverSettingsAssets(configRoot, capturedAt),
  ]
  for (const group of groups) {
    for await (const asset of group) {
      if (ctx.abortSignal.aborted) return
      yield asset
    }
  }
}

function evidenceFor(record: SourceRecord): EvidenceCandidate {
  const runtime = record.locator.kind === 'runtime-hook'
  return {
    captureMethod: runtime ? 'runtime-hook' : 'native-log',
    derivation: runtime ? 'observed' : 'reported',
    sourceRecordId: record.id,
    sourceLocator: record.locator,
    parserVersion: record.parserVersion,
    ...(record.nativeId ? { nativeStableId: record.nativeId } : {}),
    ...(record.occurredAt ? { eventTime: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    confidenceHint: record.nativeId ? 'exact' : 'high',
  }
}

function baseIdentity(
  record: SourceRecord,
  envelope: ClaudeStoredEnvelope,
): ObservationIdentityHints {
  return {
    nativeSessionId: envelope.session.nativeSessionId || record.sourceSessionNativeId || 'unknown',
    ...(envelope.session.cwd ? { workspacePath: envelope.session.cwd } : {}),
  }
}

function candidate(
  record: SourceRecord,
  envelope: ClaudeStoredEnvelope,
  kind: ObservationCandidate['kind'],
  payload: unknown,
  options: {
    nativeCallId?: string
    nativeEventId?: string
    identity?: Partial<ObservationIdentityHints>
  } = {},
): ObservationCandidate {
  const nativeCallId = options.nativeCallId
  const eventId = options.nativeEventId ?? (!nativeCallId ? record.nativeId : undefined)
  return {
    kind,
    ...(eventId ? { nativeEventId: eventId } : {}),
    ...(nativeCallId ? { nativeCallId } : {}),
    ...(record.sourceSequence === undefined ? {} : { sourceSequence: record.sourceSequence }),
    ...(record.occurredAt ? { occurredAt: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    payload,
    identityHints: {
      ...baseIdentity(record, envelope),
      ...(options.identity ?? {}),
    },
    dedupHints: {
      ...(eventId ? { nativeEventId: eventId } : {}),
      ...(nativeCallId ? { nativeCallId } : {}),
      ...(record.sourceSequence === undefined ? {} : { sourceSequence: record.sourceSequence }),
      ...(record.fingerprint ? { payloadFingerprint: record.fingerprint } : {}),
    },
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (typeof block === 'string') return block
    const item = asRecord(block)
    const type = stringField(item, 'type')
    if (type === 'text') return stringField(item, 'text') ?? ''
    return ''
  }).filter(Boolean).join('\n\n')
}

function runtimeEnvelope(record: SourceRecord): {
  envelope: ClaudeStoredEnvelope
  event: Record<string, unknown>
} {
  const payload = asRecord(record.payload)
  const event = asRecord(payload.runtimeEvent)
  const session = asRecord(payload.session)
  const cwd = stringField(session, 'cwd')
  return {
    envelope: {
      entry: event,
      session: {
        nativeSessionId: stringField(session, 'nativeSessionId')
          ?? record.sourceSessionNativeId
          ?? 'runtime-unknown',
        ...(cwd ? { cwd } : {}),
      },
    },
    event,
  }
}

function normalizeRuntime(record: SourceRecord): ObservationCandidate {
  const { envelope, event } = runtimeEnvelope(record)
  const hookName = runtimeEventName(event)
  const callId = stringField(event, 'tool_use_id', 'call_id')
  const toolName = stringField(event, 'tool_name', 'name') ?? 'unknown'
  const actorId = stringField(event, 'agent_id', 'subagent_id')
  const turnId = stringField(event, 'turn_id')
  const identity = actorId
    ? { nativeActorId: actorId, actorRole: 'subagent' as const }
    : {}

  if (hookName === 'PreToolUse') {
    const stableCallId = callId ?? `claude-runtime-call-${record.id}`
    return candidate(record, envelope, 'tool.call', {
      callId: stableCallId,
      nativeToolName: toolName,
      input: event.tool_input ?? {},
      ...(turnId ? { turnId } : {}),
    }, { nativeCallId: stableCallId, identity })
  }
  if (hookName === 'PostToolUse') {
    const stableCallId = callId ?? `claude-runtime-call-${record.id}`
    const response = event.tool_response ?? event.output ?? event.result ?? null
    const responseRecord = asRecord(response)
    const success = event.success === false
      || responseRecord.is_error === true
      || responseRecord.success === false
      ? false
      : true
    return candidate(record, envelope, 'tool.result', {
      callId: stableCallId,
      nativeToolName: toolName,
      success,
      ...(response == null ? {} : { output: response }),
      ...(typeof event.duration_ms === 'number' ? { durationMs: event.duration_ms } : {}),
    }, { nativeCallId: stableCallId, identity })
  }
  if (hookName === 'SessionStart' || hookName === 'SessionEnd') {
    return candidate(record, envelope, 'session.lifecycle', {
      event: hookName === 'SessionStart' ? 'session.started' : 'session.ended',
      ...(stringField(event, 'reason') ? { reason: stringField(event, 'reason') } : {}),
    })
  }
  if (hookName === 'UserPromptSubmit') {
    return candidate(record, envelope, 'message.user', {
      text: stringField(event, 'prompt', 'message') ?? '',
      ...(turnId ? { turnId } : {}),
    })
  }
  if (hookName === 'PermissionRequest') {
    return candidate(record, envelope, 'permission.request', {
      nativeToolName: toolName,
      input: event.tool_input ?? {},
      ...(turnId ? { turnId } : {}),
    }, { identity })
  }
  if (hookName === 'PreCompact' || hookName === 'PostCompact') {
    return candidate(record, envelope, 'context.compaction', {
      phase: hookName === 'PreCompact' ? 'start' : 'end',
      ...(stringField(event, 'trigger') ? { trigger: stringField(event, 'trigger') } : {}),
      ...(turnId ? { turnId } : {}),
    })
  }
  if (hookName === 'SubagentStart' || hookName === 'SubagentStop') {
    return candidate(
      record,
      envelope,
      hookName === 'SubagentStart' ? 'subagent.spawn' : 'subagent.end',
      {
        ...(actorId ? { nativeActorId: actorId } : {}),
        ...(stringField(event, 'agent_type') ? { agentType: stringField(event, 'agent_type') } : {}),
        ...(turnId ? { turnId } : {}),
      },
      { identity },
    )
  }
  if (hookName === 'Stop') {
    return candidate(record, envelope, 'session.lifecycle', {
      event: 'turn.stopped',
      ...(turnId ? { turnId } : {}),
    }, { identity })
  }
  return candidate(record, envelope, 'unknown', {
    rawType: record.nativeType,
    rawPayload: event,
  })
}

export async function normalizeClaudeRecord(
  record: SourceRecord,
  _ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  if (record.locator.kind === 'runtime-hook') {
    return {
      observations: [normalizeRuntime(record)],
      evidenceCandidates: [evidenceFor(record)],
    }
  }

  const envelope = asRecord(record.payload) as unknown as ClaudeStoredEnvelope
  const entry = asRecord(envelope.entry)
  const type = stringField(entry, 'type') ?? 'unknown'
  const message = asRecord(entry.message)
  const content = message.content
  const observations: ObservationCandidate[] = []

  if (type === 'user') {
    if (typeof content === 'string') {
      if (content.trim()) observations.push(candidate(record, envelope, 'message.user', { text: truncate(content) }))
    } else if (Array.isArray(content)) {
      const text = textFromContent(content).trim()
      if (text) observations.push(candidate(record, envelope, 'message.user', { text: truncate(text) }))
      for (const rawBlock of content) {
        const block = asRecord(rawBlock)
        if (block.type !== 'tool_result') continue
        const callId = stringField(block, 'tool_use_id') ?? `claude-result-${record.id}`
        const output = textFromContent(block.content)
        observations.push(candidate(record, envelope, 'tool.result', {
          callId,
          success: block.is_error !== true && block.is_error !== 'true',
          ...(output ? { output: truncate(output) } : {}),
        }, { nativeCallId: callId }))
      }
    }
  } else if (type === 'assistant') {
    if (Array.isArray(content)) {
      const textParts: string[] = []
      const reasoningParts: string[] = []
      for (const rawBlock of content) {
        const block = asRecord(rawBlock)
        const blockType = stringField(block, 'type') ?? 'unknown'
        if (blockType === 'text') {
          const text = stringField(block, 'text')
          if (text) textParts.push(text)
        } else if (blockType === 'thinking') {
          const thinking = stringField(block, 'thinking', 'text')
          if (thinking) reasoningParts.push(thinking)
        } else if (blockType === 'tool_use') {
          const callId = stringField(block, 'id') ?? `claude-call-${record.id}`
          observations.push(candidate(record, envelope, 'tool.call', {
            callId,
            nativeToolName: stringField(block, 'name') ?? 'unknown',
            input: block.input ?? {},
          }, { nativeCallId: callId }))
        }
      }
      if (textParts.length) observations.push(candidate(record, envelope, 'message.assistant', {
        text: truncate(textParts.join('\n\n')),
      }))
      if (reasoningParts.length) observations.push(candidate(record, envelope, 'message.reasoning', {
        text: truncate(reasoningParts.join('\n\n')),
      }))
    } else {
      const text = textFromContent(content).trim()
      if (text) observations.push(candidate(record, envelope, 'message.assistant', { text: truncate(text) }))
    }
  } else if (type === 'summary') {
    observations.push(candidate(record, envelope, 'context.summary', {
      text: truncate(textFromContent(entry.summary ?? content)),
    }))
  }

  if (!observations.length) {
    observations.push(candidate(record, envelope, 'unknown', {
      rawType: record.nativeType,
      rawPayload: entry,
    }))
  }
  return { observations, evidenceCandidates: [evidenceFor(record)] }
}

export async function declareClaudeCapabilities(
  _detected: DetectedSource,
): Promise<ObservationCapability[]> {
  return [
    { sourceId: SOURCE_ID, name: 'session', status: 'available', captureModes: ['history', 'runtime-hook'] },
    { sourceId: SOURCE_ID, name: 'transcript', status: 'available', captureModes: ['history'] },
    { sourceId: SOURCE_ID, name: 'tool-call', status: 'available', captureModes: ['history', 'runtime-hook'] },
    { sourceId: SOURCE_ID, name: 'tool-result', status: 'available', captureModes: ['history', 'runtime-hook'] },
    { sourceId: SOURCE_ID, name: 'permission', status: 'available', captureModes: ['runtime-hook'] },
    { sourceId: SOURCE_ID, name: 'subagent', status: 'available', captureModes: ['runtime-hook'] },
    { sourceId: SOURCE_ID, name: 'context', status: 'partial', captureModes: ['history', 'runtime-hook'], reason: 'Summary and compaction lifecycle are visible; full context is not' },
    { sourceId: SOURCE_ID, name: 'thinking', status: 'partial', captureModes: ['history'], reason: 'Only source-visible thinking blocks are captured' },
    { sourceId: SOURCE_ID, name: 'asset-discovery', status: 'available', captureModes: ['static-scan'] },
    { sourceId: SOURCE_ID, name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: 'Invocation attribution is handled by later usage projections' },
    { sourceId: SOURCE_ID, name: 'usage', status: 'unavailable', captureModes: [], reason: 'Stable usage mapping is not implemented' },
    { sourceId: SOURCE_ID, name: 'artifact-action', status: 'unavailable', captureModes: [], reason: 'Artifact attribution is not implemented' },
  ]
}

export const claudeManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-claude',
  pluginVersion: '1.0.0-alpha.2',
  apiVersion: '1.0',
  pluginType: 'source',
  displayName: 'Claude Code Source',
  sourceId: SOURCE_ID,
  productId: SOURCE_ID,
  parserVersion: PARSER_VERSION,
}

export const claudeSourceDefinition: SourceDefinition = {
  manifest: claudeManifest,
  detect: detectClaudeCode,
  declareCapabilities: declareClaudeCapabilities,
  discoverAssets: discoverClaudeAssets,
  ingestHistory: ingestClaudeHistory,
  startCapture: startClaudeRuntimeCapture,
  normalize: normalizeClaudeRecord,
}

const applyClaudeSource = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.sources.register(claudeSourceDefinition)
    return () => registration.dispose()
  },
  { inject: ['sources'] },
)

export const claudeSourcePlugin = defineAgentLensPlugin(claudeManifest, applyClaudeSource)

export const claudeInternals = {
  runtimeInboxDirectory,
  parseRuntimeEnvelope,
  runtimeRecord,
  textFromContent,
}
