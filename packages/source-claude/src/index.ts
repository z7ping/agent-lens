import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  stat,
  unlink,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path'
import {
  evidenceFromSourceRecord,
  observationFromSourceRecord,
  type DetectedSource,
  type Disposable,
  type EvidenceCandidate,
  type NormalizedSourceOutput,
  type ObservationCapability,
  type ObservationCandidate,
  type ObservationIdentityHints,
  type SourceDefinition,
  type SourceDetectionContext,
  type SourceExecutionContext,
  type SourceHistoryExecutionContext,
  type SourceHistoryWindow,
  type SourceNormalizationContext,
  type SourcePluginManifest,
  type SourceRecord,
  type SourceRecordEmitter,
} from '@agent-lens/core'
import {
  abortableDelay,
  defineAgentLensPlugin,
  resolveClaudeLocation,
  resolveExecutable,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import {
  isCompleteJson,
  isMissingPathError,
  readJsonlLines,
  sourceFileIdentity,
  startHistoryFileWatch,
} from '@agent-lens/source-support'
import { discoverClaudeAssets } from './assets.js'
import { CLAUDE_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY } from './workspace-context.js'

const SOURCE_ID = 'claude-code'
const PARSER_VERSION = '4'
const RUNTIME_POLL_MS = 250

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
  fileId?: string
}


interface RuntimeInboxEnvelope {
  id: string
  capturedAt: string
  event: Record<string, unknown>
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
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

function claudeStoredEnvelope(value: unknown, record: SourceRecord): ClaudeStoredEnvelope {
  const payload = asRecord(value)
  const session = asRecord(payload.session)
  const cwd = stringField(session, 'cwd')
  return {
    entry: asRecord(payload.entry),
    session: {
      nativeSessionId: stringField(session, 'nativeSessionId')
        ?? record.sourceSessionNativeId
        ?? 'unknown',
      ...(cwd ? { cwd } : {}),
    },
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw error
  }
}

export async function detectClaudeCode(
  ctx: SourceDetectionContext,
): Promise<DetectedSource[]> {
  const env = ctx.env ?? process.env
  const location = resolveClaudeLocation(env)
  const [homeExists, projectsExist, executable] = await Promise.all([
    exists(location.configRoot),
    exists(location.dataRoot),
    resolveExecutable('claude', {
      explicit: env.CLAUDE_BIN,
      pathValue: env.PATH ?? process.env.PATH,
    }),
  ])
  if (!homeExists && !projectsExist && !executable) return []

  return [{
    sourceId: SOURCE_ID,
    productId: SOURCE_ID,
    ...(executable ? { executable } : {}),
    configRoot: location.configRoot,
    dataRoot: location.dataRoot,
    confidence: executable && projectsExist ? 'exact' : 'high',
  }]
}

async function* walkJsonlFiles(root: string): AsyncIterable<string> {
  let directory
  try {
    directory = await opendir(root)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }

  for await (const entry of directory) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) yield* walkJsonlFiles(path)
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.jsonl') yield path
  }
}

async function listJsonlFiles(root: string, historyWindow?: SourceHistoryWindow): Promise<string[]> {
  const paths: string[] = []
  for await (const file of walkJsonlFiles(root)) paths.push(file)
  const candidates = (await Promise.all(paths.map(async path => {
    try {
      return { path, mtimeMs: (await stat(path)).mtimeMs }
    } catch (error) {
      if (isMissingPathError(error)) return null
      throw error
    }
  }))).filter((candidate): candidate is { path: string; mtimeMs: number } => candidate !== null)

  const activeSince = historyWindow?.activeSince ? Date.parse(historyWindow.activeSince) : Number.NaN
  const filtered = Number.isFinite(activeSince)
    ? candidates.filter(candidate => candidate.mtimeMs >= activeSince)
    : candidates
  const ordered = filtered.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path))
  const limit = historyWindow?.sessionLimit
  return (limit === undefined ? ordered : ordered.slice(0, Math.max(0, Math.floor(limit))))
    .map(candidate => candidate.path)
}

function parseHistoryLine(text: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return { type: 'malformed-json', raw: text }
  }
}

function nativeSessionId(entry: Record<string, unknown>, filePath: string): string {
  return stringField(entry, 'sessionId', 'session_id')
    ?? basename(filePath, extname(filePath))
}

function nativeEntryId(entry: Record<string, unknown>): string | undefined {
  return stringField(entry, 'uuid', 'id', 'messageId', 'message_id')
}

function sourceNativeEventId(record: SourceRecord, envelope: ClaudeStoredEnvelope): string | undefined {
  if (record.locator.kind === 'runtime-hook') {
    return stringField(envelope.entry, 'source_event_id', 'hook_invocation_id')
  }
  return nativeEntryId(envelope.entry)
}

function historyCheckpointKey(filePath: string): string {
  return `claude:history:v2-session-title:${sha256(filePath)}`
}

async function readClaudeSessionCwd(filePath: string): Promise<string | undefined> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(256 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const preview = buffer.subarray(0, bytesRead).toString('utf8')
    for (const line of preview.split(/\r?\n/).slice(0, 64)) {
      if (!line.trim()) continue
      try {
        const entry = asRecord(JSON.parse(line))
        const cwd = stringField(entry, 'cwd')
        if (cwd) return cwd
      } catch {
        // History ingest owns malformed-record preservation; migration lookup only needs cwd.
      }
    }
    return undefined
  } finally {
    await handle.close()
  }
}

export async function* ingestClaudeFile(
  ctx: SourceExecutionContext,
  filePath: string,
  onWorkspace?: (cwd: string) => void,
): AsyncIterable<SourceRecord> {
  if (ctx.abortSignal.aborted) return

  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }

  const initialFileId = sourceFileIdentity(fileStat)
  const key = historyCheckpointKey(filePath)
  const previous = await ctx.checkpoint.get<HistoryCheckpoint>(key)
  const sameKnownFile = previous?.fileId === undefined || previous.fileId === initialFileId
  const unchanged = previous
    && previous.path === filePath
    && sameKnownFile
    && previous.offset === fileStat.size
    && previous.size === fileStat.size
    && previous.mtimeMs === fileStat.mtimeMs

  if (unchanged) {
    if (!previous.fileId) {
      await ctx.checkpoint.set(key, { ...previous, fileId: initialFileId })
    }
    return
  }

  const reset = !previous
    || previous.path !== filePath
    || (previous.fileId !== undefined && previous.fileId !== initialFileId)
    || fileStat.size < previous.offset
  let offset = reset ? 0 : previous.offset
  let sequence = reset ? 0 : previous.sequence
  let lastCwd: string | undefined
  let incompleteTail = false

  const persistCheckpoint = async (
    size: number,
    mtimeMs: number,
  ): Promise<void> => {
    await ctx.checkpoint.set(key, {
      path: filePath,
      offset,
      sequence,
      size,
      mtimeMs,
      fileId: initialFileId,
    })
  }

  for await (const line of readJsonlLines(filePath, offset)) {
    if (ctx.abortSignal.aborted) return
    if (!line.terminated && line.text.trim() && !isCompleteJson(line.text)) {
      incompleteTail = true
      break
    }

    sequence += 1
    offset = line.endOffset
    if (!line.text.trim()) {
      await persistCheckpoint(fileStat.size, fileStat.mtimeMs)
      continue
    }

    const entry = parseHistoryLine(line.text)
    const cwd = stringField(entry, 'cwd') ?? lastCwd
    if (cwd) {
      lastCwd = cwd
      onWorkspace?.(cwd)
    }
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

    yield {
      id: `claude-record-${sha256(`${filePath}|${line.startOffset}|${fingerprint}`).slice(0, 32)}`,
      sourceId: SOURCE_ID,
      installationId: ctx.installation.id,
      ...(sessionId ? { sourceSessionNativeId: sessionId } : {}),
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

    await persistCheckpoint(fileStat.size, fileStat.mtimeMs)
  }

  // Keep EOF metadata current without confusing a path replacement with an append.
  if (!ctx.abortSignal.aborted && !incompleteTail) {
    try {
      const finalStat = await stat(filePath)
      if (sourceFileIdentity(finalStat) === initialFileId) {
        await persistCheckpoint(finalStat.size, finalStat.mtimeMs)
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error
    }
  }
}

export async function* ingestClaudeHistory(
  ctx: SourceHistoryExecutionContext,
): AsyncIterable<SourceRecord> {
  const projectsDir = ctx.installation.dataRoot
    ?? (ctx.installation.configRoot ? join(ctx.installation.configRoot, 'projects') : undefined)
  if (!projectsDir) return

  const remembered = await ctx.checkpoint.get<string[]>(CLAUDE_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY) ?? []
  const knownCwds = new Map<string, string>()
  for (const value of remembered) {
    const raw = value.trim()
    if (!raw || !isAbsolute(raw)) continue
    const cwd = resolve(raw)
    const key = process.platform === 'win32'
      ? cwd.replaceAll('\\', '/').toLowerCase()
      : cwd.replaceAll('\\', '/')
    if (!knownCwds.has(key)) knownCwds.set(key, cwd)
  }

  const rememberWorkspace = (value: string) => {
    const raw = value.trim()
    if (!raw || !isAbsolute(raw)) return
    const cwd = resolve(raw)
    const key = process.platform === 'win32'
      ? cwd.replaceAll('\\', '/').toLowerCase()
      : cwd.replaceAll('\\', '/')
    if (!knownCwds.has(key)) knownCwds.set(key, cwd)
  }

  const files = await listJsonlFiles(projectsDir, ctx.historyWindow)
  const needsWorkspaceBackfill = remembered.length === 0
  for (const filePath of files) {
    if (ctx.abortSignal.aborted) return
    if (needsWorkspaceBackfill) {
      const cwd = await readClaudeSessionCwd(filePath)
      if (cwd) rememberWorkspace(cwd)
    }
    yield* ingestClaudeFile(ctx, filePath, rememberWorkspace)
  }

  if (!ctx.abortSignal.aborted) {
    await ctx.checkpoint.set(
      CLAUDE_KNOWN_PROJECT_CWDS_CHECKPOINT_KEY,
      [...knownCwds.values()],
    )
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
  return stringField(event, 'source_event_id', 'hook_invocation_id')
}

function parseRuntimeEnvelope(text: string, fileName: string): RuntimeInboxEnvelope {
  try {
    const parsed = asRecord(JSON.parse(text))
    return {
      id: stringField(parsed, 'id') ?? fileName,
      capturedAt: stringField(parsed, 'capturedAt') ?? new Date().toISOString(),
      event: asRecord(parsed.event),
    }
  } catch {
    return {
      id: fileName,
      capturedAt: new Date().toISOString(),
      event: { hook_event_name: 'MalformedInboxEvent', raw: text },
    }
  }
}

function runtimeRecord(
  envelope: RuntimeInboxEnvelope,
  filePath: string,
  ctx: SourceExecutionContext,
): SourceRecord {
  const event = envelope.event
  const sessionId = stringField(event, 'session_id', 'sessionId')
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
        ...(sessionId ? { nativeSessionId: sessionId } : {}),
        ...(cwd ? { cwd } : {}),
      },
    },
    parserVersion: PARSER_VERSION,
  }
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
      } catch (error) {
        if (!isMissingPathError(error)) throw error
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
      if (!stopped && !ctx.abortSignal.aborted) await abortableDelay(RUNTIME_POLL_MS, ctx.abortSignal)
    }
  })()

  const projectsDir = ctx.installation.dataRoot
    ?? (ctx.installation.configRoot ? join(ctx.installation.configRoot, 'projects') : undefined)
  const historyWatch = projectsDir
    ? await startHistoryFileWatch({
        root: projectsDir,
        signal: ctx.abortSignal,
        accept: filePath => extname(filePath).toLowerCase() === '.jsonl',
        listFiles: limit => listJsonlFiles(
          projectsDir,
          limit === undefined ? undefined : { sessionLimit: limit },
        ),
        onFile: async filePath => {
          for await (const record of ingestClaudeFile(ctx, filePath)) {
            await emitter.emit(record)
          }
        },
        debounceMs: 180,
        fallbackPollMs: 60_000,
        fallbackReconcileLimit: 20,
        reconcilePollMs: 5 * 60_000,
        reconcileLimit: 20,
        onError: error => {
          console.error('[AgentLens] Claude history reconcile failed', error)
        },
      })
    : null

  return {
    async dispose(): Promise<void> {
      if (stopped) return
      stopped = true
      await historyWatch?.dispose()
      await task
    },
  }
}

function evidenceFor(record: SourceRecord, envelope: ClaudeStoredEnvelope): EvidenceCandidate {
  const runtime = record.locator.kind === 'runtime-hook'
  const nativeStableId = sourceNativeEventId(record, envelope)
  return evidenceFromSourceRecord(record, {
    captureMethod: runtime ? 'runtime-hook' : 'native-log',
    derivation: runtime ? 'observed' : 'reported',
    ...(nativeStableId ? { nativeStableId } : {}),
    confidenceHint: nativeStableId ? 'exact' : 'high',
  })
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
    sharedEventKey?: string
    sequenceOffset?: number
    identity?: Partial<ObservationIdentityHints>
  } = {},
): ObservationCandidate {
  const nativeEventId = options.nativeEventId
    ?? (!options.nativeCallId && !options.sharedEventKey
      ? sourceNativeEventId(record, envelope)
      : undefined)
  return observationFromSourceRecord(record, {
    kind,
    payload,
    identityHints: {
      ...baseIdentity(record, envelope),
      ...(options.identity ?? {}),
    },
    ...(nativeEventId ? { nativeEventId } : {}),
    ...(options.nativeCallId ? { nativeCallId: options.nativeCallId } : {}),
    ...(options.sharedEventKey ? { sharedEventKey: options.sharedEventKey } : {}),
    ...(options.sequenceOffset === undefined ? {} : { sequenceOffset: options.sequenceOffset }),
  })
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
  envelope?: ClaudeStoredEnvelope
  event: Record<string, unknown>
} {
  const payload = asRecord(record.payload)
  const event = asRecord(payload.runtimeEvent)
  const session = asRecord(payload.session)
  const cwd = stringField(session, 'cwd')
  const storedSessionId = stringField(session, 'nativeSessionId') ?? record.sourceSessionNativeId
  const nativeSessionId = storedSessionId === 'unknown' || storedSessionId === 'runtime-unknown'
    ? undefined
    : storedSessionId
  return {
    ...(nativeSessionId ? {
      envelope: {
        entry: event,
        session: {
          nativeSessionId,
          ...(cwd ? { cwd } : {}),
        },
      },
    } : {}),
    event,
  }
}

function normalizeRuntime(record: SourceRecord): ObservationCandidate | null {
  const { envelope, event } = runtimeEnvelope(record)
  if (!envelope) return null
  const hookName = runtimeEventName(event)
  const callId = stringField(event, 'tool_use_id', 'call_id')
  const toolName = stringField(event, 'tool_name', 'name') ?? 'unknown'
  const actorId = stringField(event, 'agent_id', 'subagent_id')
  const turnId = stringField(event, 'turn_id')
  const identity = actorId
    ? { nativeActorId: actorId, actorRole: 'subagent' as const }
    : {}

  if (hookName === 'PreToolUse') {
    return candidate(record, envelope, 'tool.call', {
      ...(callId ? { callId } : {}),
      nativeToolName: toolName,
      input: event.tool_input ?? {},
      ...(turnId ? { turnId } : {}),
    }, {
      ...(callId ? { nativeCallId: callId } : { sharedEventKey: `claude-runtime:${record.id}` }),
      identity,
    })
  }
  if (hookName === 'PostToolUse') {
    const response = event.tool_response ?? event.output ?? event.result ?? null
    const responseRecord = asRecord(response)
    const success = event.success === false
      || responseRecord.is_error === true
      || responseRecord.success === false
      ? false
      : true
    return candidate(record, envelope, 'tool.result', {
      ...(callId ? { callId } : {}),
      nativeToolName: toolName,
      success,
      ...(response == null ? {} : { output: response }),
      ...(typeof event.duration_ms === 'number' ? { durationMs: event.duration_ms } : {}),
    }, {
      ...(callId ? { nativeCallId: callId } : { sharedEventKey: `claude-runtime:${record.id}` }),
      identity,
    })
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
    const runtime = runtimeEnvelope(record)
    const observation = runtime.envelope ? normalizeRuntime(record) : null
    return {
      observations: observation ? [observation] : [],
      evidenceCandidates: runtime.envelope ? [evidenceFor(record, runtime.envelope)] : [],
    }
  }

  const envelope = claudeStoredEnvelope(record.payload, record)
  const entry = envelope.entry
  const type = stringField(entry, 'type') ?? 'unknown'
  const message = asRecord(entry.message)
  const content = message.content
  const observations: ObservationCandidate[] = []

  if (type === 'user') {
    if (typeof content === 'string') {
      if (content.trim()) observations.push(candidate(record, envelope, 'message.user', { text: content }))
    } else if (Array.isArray(content)) {
      const text = textFromContent(content).trim()
      if (text) observations.push(candidate(record, envelope, 'message.user', { text }))
      for (const [blockIndex, rawBlock] of content.entries()) {
        const block = asRecord(rawBlock)
        if (block.type !== 'tool_result') continue
        const callId = stringField(block, 'tool_use_id')
        const output = textFromContent(block.content)
        observations.push(candidate(record, envelope, 'tool.result', {
          ...(callId ? { callId } : {}),
          success: block.is_error !== true && block.is_error !== 'true',
          ...(output ? { output } : {}),
        }, {
          ...(callId
            ? { nativeCallId: callId }
            : { sharedEventKey: `claude-result:${record.id}:${blockIndex}` }),
          sequenceOffset: blockIndex + 1,
        }))
      }
    }
  } else if (type === 'assistant') {
    if (Array.isArray(content)) {
      const textParts: string[] = []
      const reasoningParts: string[] = []
      for (const [blockIndex, rawBlock] of content.entries()) {
        const block = asRecord(rawBlock)
        const blockType = stringField(block, 'type') ?? 'unknown'
        if (blockType === 'text') {
          const text = stringField(block, 'text')
          if (text) textParts.push(text)
        } else if (blockType === 'thinking') {
          const thinking = stringField(block, 'thinking', 'text')
          if (thinking) reasoningParts.push(thinking)
        } else if (blockType === 'tool_use') {
          const callId = stringField(block, 'id')
          observations.push(candidate(record, envelope, 'tool.call', {
            ...(callId ? { callId } : {}),
            nativeToolName: stringField(block, 'name') ?? 'unknown',
            input: block.input ?? {},
          }, {
            ...(callId
              ? { nativeCallId: callId }
              : { sharedEventKey: `claude-call:${record.id}:${blockIndex}` }),
            sequenceOffset: blockIndex + 1,
          }))
        }
      }
      if (textParts.length) observations.push(candidate(record, envelope, 'message.assistant', {
        text: textParts.join('\n\n'),
      }))
      if (reasoningParts.length) observations.push(candidate(record, envelope, 'message.reasoning', {
        text: reasoningParts.join('\n\n'),
      }, { sharedEventKey: `claude-reasoning:${record.id}` }))
    } else {
      const text = textFromContent(content).trim()
      if (text) observations.push(candidate(record, envelope, 'message.assistant', { text: text }))
    }
  } else if (type === 'custom-title') {
    const title = stringField(entry, 'customTitle', 'custom_title')?.trim()
    observations.push(candidate(record, envelope, 'session.lifecycle', {
      event: 'session.title',
      ...(title ? { title } : {}),
    }, { identity: title ? { sessionTitle: title } : {} }))
  } else if (type === 'summary') {
    observations.push(candidate(record, envelope, 'context.summary', {
      text: textFromContent(entry.summary ?? content),
    }))
  }

  if (!observations.length) {
    observations.push(candidate(record, envelope, 'unknown', {
      rawType: record.nativeType,
      rawPayload: entry,
    }))
  }
  return { observations, evidenceCandidates: [evidenceFor(record, envelope)] }
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
    { sourceId: SOURCE_ID, name: 'asset-discovery', status: 'partial', captureModes: ['static-scan'], reason: 'User-profile assets and history-known project assets are observable; managed settings, dynamic nested context, plugin installation state and runtime discoverability require stronger Claude Code runtime evidence' },
    { sourceId: SOURCE_ID, name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: 'Invocation attribution is handled by later usage projections' },
    { sourceId: SOURCE_ID, name: 'usage', status: 'unavailable', captureModes: [], reason: 'Stable usage mapping is not implemented' },
    { sourceId: SOURCE_ID, name: 'artifact-action', status: 'unavailable', captureModes: [], reason: 'Artifact attribution is not implemented' },
  ]
}

export const claudeManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-claude',
  pluginVersion: '1.0.0-alpha.5',
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
  historyCheckpointKey,
  listJsonlFiles,
  runtimeInboxDirectory,
  parseRuntimeEnvelope,
  runtimeRecord,
  textFromContent,
  claudeStoredEnvelope,
  readClaudeSessionCwd,
}

export * from './assets.js'
export * from './project-context.js'
export * from './workspace-context.js'
