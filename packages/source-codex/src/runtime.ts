import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import type {
  Disposable,
  SourceExecutionContext,
  SourceRecord,
  SourceRecordEmitter,
} from '@agent-lens/core'
import { abortableDelay } from '@agent-lens/runtime-cordis'
import { archiveAcceptedHookInboxFile, prepareHookInboxArchive, nativeHookArchiveEnabled, asRecord, isMissingPathError, startHistoryFileWatch } from '@agent-lens/source-support'
import { CODEX_CURRENT_PARSER_VERSION } from './current-protocol'
import { codexHistoryRoots, ingestCodexFile, listJsonlFiles } from './history'

const POLL_INTERVAL_MS = 250

interface CodexInboxEnvelope {
  id: string
  capturedAt: string
  event: Record<string, unknown>
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}



function inboxDirectory(): string {
  return process.env.AGENT_LENS_CODEX_INBOX
    ?? join(homedir(), '.agent-lens', '1.0', 'inbox', 'codex')
}

function stringField(event: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = event[name]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function eventName(event: Record<string, unknown>): string {
  return stringField(event, 'hook_event_name', 'event_name', 'type') ?? 'UnknownHookEvent'
}

function nativeSessionId(event: Record<string, unknown>): string | undefined {
  return stringField(event, 'session_id', 'conversation_id', 'sessionId')
}

function nativeId(event: Record<string, unknown>): string | undefined {
  return stringField(event, 'source_event_id', 'hook_invocation_id')
}

function parseEnvelope(text: string, fileName: string): CodexInboxEnvelope {
  try {
    const parsed = asRecord(JSON.parse(text))
    const event = asRecord(parsed.event)
    return {
      id: typeof parsed.id === 'string' && parsed.id ? parsed.id : fileName,
      capturedAt: typeof parsed.capturedAt === 'string' && parsed.capturedAt
        ? parsed.capturedAt
        : new Date().toISOString(),
      event,
    }
  } catch {
    return {
      id: fileName,
      capturedAt: new Date().toISOString(),
      event: {
        hook_event_name: 'MalformedInboxEvent',
        raw: text,
      },
    }
  }
}

function sourceRecordFromEnvelope(
  envelope: CodexInboxEnvelope,
  filePath: string,
  ctx: SourceExecutionContext,
): SourceRecord {
  const event = envelope.event
  const sessionId = nativeSessionId(event)
  const hookName = eventName(event)
  const stableNativeId = nativeId(event)
  const occurredAt = stringField(event, 'timestamp', 'ts') ?? envelope.capturedAt
  const cwd = stringField(event, 'cwd', 'working_directory', 'workdir')

  return {
    id: `codex-runtime-${sha256(envelope.id).slice(0, 32)}`,
    sourceId: 'codex',
    installationId: ctx.installation.id,
    ...(sessionId ? { sourceSessionNativeId: sessionId } : {}),
    nativeType: `hook/${hookName}`,
    ...(stableNativeId ? { nativeId: stableNativeId } : {}),
    occurredAt,
    capturedAt: envelope.capturedAt,
    locator: {
      kind: 'runtime-hook',
      path: filePath,
      hookEventId: envelope.id,
    },
    fingerprint: sha256(JSON.stringify(event)),
    payload: {
      runtimeEvent: event,
      session: {
        ...(sessionId ? { nativeSessionId: sessionId } : {}),
        ...(cwd ? { cwd } : {}),
      },
    },
    parserVersion: CODEX_CURRENT_PARSER_VERSION,
  }
}

export async function startCodexRuntimeCapture(
  ctx: SourceExecutionContext,
  emitter: SourceRecordEmitter,
): Promise<Disposable> {
  const inbox = inboxDirectory()
  await mkdir(inbox, { recursive: true })
  let stopped = false

  const task = (async () => {
    while (!stopped && !ctx.abortSignal.aborted) {
      let files: string[] = []
      try {
        files = (await readdir(inbox))
          .filter(name => name.endsWith('.json'))
          .sort((a, b) => a.localeCompare(b))
      } catch (error) {
        if (!isMissingPathError(error)) throw error
        files = []
      }

      for (const fileName of files) {
        if (stopped || ctx.abortSignal.aborted) break
        const filePath = join(inbox, fileName)
        try {
          const originalBytes = await readFile(filePath)
          const envelope = parseEnvelope(originalBytes.toString('utf8'), fileName)
          const record = sourceRecordFromEnvelope(envelope, filePath, ctx)
          // Seal the SAME original Hook bytes before any writer can accept
          // or reject this event. Failed delivery keeps inbox for retry and
          // still leaves a verified Source-owned single-copy archive.
          const archiveInput = nativeHookArchiveEnabled() && record.sourceSessionNativeId
            ? {
                inbox,fileName,nativeSessionId:record.sourceSessionNativeId,
                installationId:ctx.installation.id,
                expectedSha256:createHash('sha256').update(originalBytes).digest('hex'),
              }
            : null
          const archivePath = archiveInput
            ? await prepareHookInboxArchive(archiveInput) : undefined
          // Verified Hook sidecar is now the Source-owned reference. Legacy
          // ownership may still store its own SQL facts; Native-only owners
          // can verify this inode instead of attempting to rewrite events.
          const deliveredRecord = archivePath && archiveInput
            ? {...record,locator:{...record.locator,path:archivePath},
                fingerprint:archiveInput.expectedSha256}
            : record
          await emitter.emit(deliveredRecord)
          if (archiveInput) await archiveAcceptedHookInboxFile(archiveInput)
          else await unlink(filePath)
        } catch {
          // Durable inbox semantics: leave the file in place and retry later.
          break
        }
      }

      if (!stopped && !ctx.abortSignal.aborted) {
        await abortableDelay(POLL_INTERVAL_MS, ctx.abortSignal)
      }
    }
  })()

  const roots = codexHistoryRoots(ctx.installation)
  const historyWatches = await Promise.all(roots.map(root =>
    // Absent archive roots use the shared watcher's bounded poll fallback;
    // never create native Codex directories to force watch startup.
    startHistoryFileWatch({
        root,
        signal: ctx.abortSignal,
        accept: filePath => extname(filePath).toLowerCase() === '.jsonl',
        listFiles: limit => listJsonlFiles(
          root,
          limit === undefined ? undefined : { sessionLimit: limit },
        ),
        onFile: async filePath => {
          for await (const record of ingestCodexFile(ctx, filePath)) {
            await emitter.emit(record.parserVersion === CODEX_CURRENT_PARSER_VERSION
              ? record
              : { ...record, parserVersion: CODEX_CURRENT_PARSER_VERSION })
          }
        },
        debounceMs: 180,
        // 监听器已经建立；初始目录扫描不应挡住最新会话的 Canonical 导入。
        waitForReady: false,
        fallbackPollMs: 60_000,
        fallbackReconcileLimit: 20,
        reconcilePollMs: 5 * 60_000,
        reconcileLimit: 20,
        onError: error => {
          if (!isMissingPathError(error)) console.error('[AgentLens] Codex history reconcile failed', error)
        },
      }),
  ))

  return {
    async dispose(): Promise<void> {
      if (stopped) return
      stopped = true
      await Promise.all(historyWatches.map(watch => watch?.dispose()))
      await task
    },
  }
}

export const codexRuntimeInternals = {
  inboxDirectory,
  parseEnvelope,
  sourceRecordFromEnvelope,
}
