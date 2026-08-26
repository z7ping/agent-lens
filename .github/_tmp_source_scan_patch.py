from pathlib import Path

pi = Path('packages/source-pi/src/index.ts')
text = pi.read_text()
text = text.replace("import { createReadStream } from 'node:fs'", "import { createReadStream, watch, type FSWatcher } from 'node:fs'")
text = text.replace("const POLL_MS = 500\n", "const RUNTIME_FALLBACK_POLL_MS = 5000\nconst RUNTIME_DEBOUNCE_MS = 180\n")

start = text.index('export async function* ingestPiHistory(')
end = text.index('\nasync function safeStat(', start)
replacement = r'''async function* ingestPiFile(
  ctx: SourceExecutionContext,
  filePath: string,
): AsyncIterable<SourceRecord> {
  if (ctx.abortSignal.aborted || extname(filePath).toLowerCase() !== '.jsonl') return
  let fileStat
  try { fileStat = await stat(filePath) } catch { return }
  const key = historyCheckpointKey(filePath)
  const previous = await ctx.checkpoint.get<HistoryCheckpoint>(key)
  const unchanged = previous
    && previous.path === filePath
    && previous.offset === fileStat.size
    && previous.size === fileStat.size
    && previous.mtimeMs === fileStat.mtimeMs
  if (unchanged) return

  const reset = !previous || previous.path !== filePath || fileStat.size < previous.offset
  let offset = reset ? 0 : previous.offset
  let sequence = reset ? 0 : previous.sequence
  const session = await sessionMetadata(filePath)

  for await (const line of readJsonlLines(filePath, offset)) {
    if (ctx.abortSignal.aborted) return
    sequence += 1
    offset = line.endOffset
    if (!line.text.trim()) {
      await ctx.checkpoint.set(key, {
        path: filePath, offset, sequence, size: fileStat.size, mtimeMs: fileStat.mtimeMs,
      })
      continue
    }
    const entry = parseLine(line.text)
    const fingerprint = sha256(line.text)
    const entryId = nativeId(entry, session.nativeSessionId)
    const timestamp = normalizeTimestamp(entry.timestamp)
      ?? normalizeTimestamp(asRecord(entry.message).timestamp)
    yield {
      id: `pi-record-${sha256(`${filePath}|${line.startOffset}|${fingerprint}`).slice(0, 32)}`,
      sourceId: SOURCE_ID,
      installationId: ctx.installation.id,
      sourceSessionNativeId: session.nativeSessionId,
      nativeType: `history/${stringField(entry, 'type') ?? 'unknown'}`,
      ...(entryId ? { nativeId: entryId } : {}),
      sourceSequence: sequence * 1000,
      ...(timestamp ? { occurredAt: timestamp } : {}),
      capturedAt: new Date().toISOString(),
      locator: { kind: 'file', path: filePath, offset: line.startOffset },
      fingerprint,
      payload: { entry, session } satisfies PiStoredEnvelope,
      parserVersion: PARSER_VERSION,
    }
    await ctx.checkpoint.set(key, {
      path: filePath, offset, sequence, size: fileStat.size, mtimeMs: fileStat.mtimeMs,
    })
  }
}

export async function* ingestPiHistory(ctx: SourceExecutionContext): AsyncIterable<SourceRecord> {
  const sessionsDir = ctx.installation.dataRoot
    ?? (ctx.installation.configRoot ? join(ctx.installation.configRoot, 'sessions') : undefined)
  if (!sessionsDir) return
  for (const filePath of await listJsonlFiles(sessionsDir)) {
    if (ctx.abortSignal.aborted) return
    yield* ingestPiFile(ctx, filePath)
  }
}

export async function startPiRuntimeCapture(
  ctx: SourceExecutionContext,
  emitter: SourceRecordEmitter,
): Promise<Disposable> {
  const sessionsDir = ctx.installation.dataRoot
    ?? (ctx.installation.configRoot ? join(ctx.installation.configRoot, 'sessions') : undefined)
  if (!sessionsDir || !await exists(sessionsDir)) return { dispose() {} }

  let stopped = false
  let watcher: FSWatcher | null = null
  let pollTimer: NodeJS.Timeout | null = null
  const debounce = new Map<string, NodeJS.Timeout>()
  let processing = Promise.resolve()

  const emitFile = (filePath: string) => {
    processing = processing.then(async () => {
      for await (const record of ingestPiFile(ctx, filePath)) {
        if (stopped || ctx.abortSignal.aborted) return
        await emitter.emit(record)
      }
    }).catch(() => undefined)
  }

  const schedule = (filePath: string) => {
    if (stopped || extname(filePath).toLowerCase() !== '.jsonl') return
    const previous = debounce.get(filePath)
    if (previous) clearTimeout(previous)
    debounce.set(filePath, setTimeout(() => {
      debounce.delete(filePath)
      emitFile(filePath)
    }, RUNTIME_DEBOUNCE_MS))
  }

  const poll = async () => {
    if (stopped || ctx.abortSignal.aborted) return
    for (const filePath of await listJsonlFiles(sessionsDir)) schedule(filePath)
  }

  const startFallbackPolling = () => {
    if (pollTimer || stopped) return
    pollTimer = setInterval(() => { void poll().catch(() => undefined) }, RUNTIME_FALLBACK_POLL_MS)
  }

  try {
    watcher = watch(sessionsDir, { recursive: true }, (_event, fileName) => {
      if (!fileName) return
      schedule(join(sessionsDir, fileName.toString()))
    })
    watcher.on('error', () => {
      watcher?.close()
      watcher = null
      startFallbackPolling()
    })
  } catch {
    watcher = null
    startFallbackPolling()
  }

  return {
    async dispose(): Promise<void> {
      if (stopped) return
      stopped = true
      watcher?.close()
      if (pollTimer) clearInterval(pollTimer)
      for (const timer of debounce.values()) clearTimeout(timer)
      debounce.clear()
      await processing
    },
  }
}
'''
pi.write_text(text[:start] + replacement + text[end:])

dsh = Path('apps/daemon/src/sources/dsh.ts')
text = dsh.read_text()
if 'interface DshFileCheckpoint' not in text:
    text = text.replace('interface DshEnvelope {', '''interface DshFileCheckpoint {
  path: string
  size: number
  mtimeMs: number
}

interface DshEnvelope {''')
text = text.replace(
'''function checkpointKey(nativeSessionId: string): string {
  return `session:${sha256(nativeSessionId).slice(0, 24)}`
}
''',
'''function checkpointKey(nativeSessionId: string): string {
  return `session:${sha256(nativeSessionId).slice(0, 24)}`
}

function fileCheckpointKey(path: string): string {
  return `file:${sha256(path).slice(0, 24)}`
}
''')
old = '''  for (const path of await sessionFiles(root)) {
    if (ctx.abortSignal.aborted) return
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
  }
'''
new = '''  for (const path of await sessionFiles(root)) {
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
'''
if old not in text:
    raise SystemExit('DSH history target not found')
text = text.replace(old, new)
old = '''  for (const event of session.events) {
    if (ctx.abortSignal.aborted) return
    const seq = numberField(event, 'seq') ?? 0
    if (seq <= after) continue
    await emitter.emit(eventRecord(session, event, ctx, 'native-tail'))
    after = seq
    await ctx.checkpoint.set(key, after)
  }
}
'''
new = '''  for (const event of session.events) {
    if (ctx.abortSignal.aborted) return
    const seq = numberField(event, 'seq') ?? 0
    if (seq <= after) continue
    await emitter.emit(eventRecord(session, event, ctx, 'native-tail'))
    after = seq
    await ctx.checkpoint.set(key, after)
  }
  const meta = await stat(path).catch(() => null)
  if (meta) await ctx.checkpoint.set(fileCheckpointKey(path), { path, size: meta.size, mtimeMs: meta.mtimeMs })
}
'''
if old not in text:
    raise SystemExit('DSH runtime target not found')
dsh.write_text(text.replace(old, new))
