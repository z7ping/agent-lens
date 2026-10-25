import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DetectedSource,
  ObservationCapability,
  SourceDefinition,
  SourcePluginManifest,
} from '@agent-lens/core'
import {
  defineAgentLensPlugin,
  type AgentLensContext,
} from '@agent-lens/runtime-cordis'
import { readArchivedHookInboxSession, readAuthorizedNativeJsonlEntry, readNativeSessionWindow, verifyJsonlLineSha256 } from '@agent-lens/source-support'
import { discoverCodexAssets } from './assets'
import {
  CODEX_CURRENT_PARSER_VERSION,
  normalizeCurrentCodexRecord,
} from './current-protocol'
import { detectCodex } from './detect'
import { codexHistoryRoots, ingestCodexHistory, listCodexHistoryFiles, readSessionMetadata } from './history'
import { nativeIdForEntry, nativeTypeForEntry } from './format'
import { codexRuntimeInternals, startCodexRuntimeCapture } from './runtime'
import { normalizeCodexSessionAttribution } from './session-attribution'

export const codexManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-codex',
  pluginVersion: '1.0.0-alpha.7',
  apiVersion: '1.0',
  pluginType: 'source',
  displayName: 'Codex Source',
  sourceId: 'codex',
  productId: 'codex',
  parserVersion: CODEX_CURRENT_PARSER_VERSION,
}

export async function declareCodexCapabilities(
  _detected: DetectedSource,
): Promise<ObservationCapability[]> {
  return [
    { sourceId: 'codex', name: 'session', status: 'available', captureModes: ['history', 'runtime-hook'] },
    { sourceId: 'codex', name: 'transcript', status: 'available', captureModes: ['history'] },
    { sourceId: 'codex', name: 'tool-call', status: 'available', captureModes: ['history', 'runtime-hook'] },
    { sourceId: 'codex', name: 'tool-result', status: 'available', captureModes: ['history', 'runtime-hook'] },
    { sourceId: 'codex', name: 'permission', status: 'available', captureModes: ['runtime-hook'] },
    { sourceId: 'codex', name: 'subagent', status: 'available', captureModes: ['runtime-hook'] },
    { sourceId: 'codex', name: 'usage', status: 'available', captureModes: ['history'] },
    { sourceId: 'codex', name: 'context', status: 'available', captureModes: ['history', 'runtime-hook'] },
    { sourceId: 'codex', name: 'asset-discovery', status: 'partial', captureModes: ['static-scan'], reason: 'Static files and the user config are observable; effective merged config, runtime discoverability and enablement require Codex app-server/runtime evidence' },
    { sourceId: 'codex', name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: 'Asset invocation attribution is not yet implemented' },
    { sourceId: 'codex', name: 'thinking', status: 'partial', captureModes: ['history'], reason: 'Only source-visible reasoning records can be observed' },
    { sourceId: 'codex', name: 'artifact-action', status: 'partial', captureModes: ['history'], reason: 'Current persisted file-change and image-generation facts are observable; not every artifact mutation has a dedicated native event' },
  ]
}

const ingestCurrentCodexHistory: NonNullable<SourceDefinition['ingestHistory']> = async function* (ctx) {
  for await (const record of ingestCodexHistory(ctx)) {
    yield record.parserVersion === CODEX_CURRENT_PARSER_VERSION
      ? record
      : { ...record, parserVersion: CODEX_CURRENT_PARSER_VERSION }
  }
}

const jsonlRawRecovery: NonNullable<SourceDefinition['rawRecovery']> = {
  describe(record) {
    const stable = record.locator.kind === 'file'
      && Boolean(record.locator.path)
      && record.locator.offset !== undefined
      && Boolean(record.fingerprint)
    return stable
      ? {
          authority: 'native-store',
          locatorStability: 'stable',
          mutability: 'append-oriented',
          verification: 'fingerprint',
          canReread: true,
          canReparse: true,
          replayable: true,
          persistencePreference: 'reference',
        }
      : {
          authority: record.locator.kind === 'runtime-hook' ? 'agent-lens-only' : 'unknown',
          locatorStability: 'none',
          mutability: record.locator.kind === 'runtime-hook' ? 'ephemeral' : 'unknown',
          verification: 'none',
          canReread: false,
          canReparse: false,
          replayable: false,
          persistencePreference: 'preserve',
          reason: record.locator.kind === 'runtime-hook'
            ? 'runtime-hook source is consumed from an ephemeral inbox'
            : 'record does not expose a stable JSONL path+offset+fingerprint locator',
        }
  },
  async hydrate(record, ctx) {
    const read = await readAuthorizedNativeJsonlEntry({
      reference: record,
      installationId: ctx.installation.id,
      sourceId: 'codex',
      parserVersion: CODEX_CURRENT_PARSER_VERSION,
      allowedRoots: codexHistoryRoots(ctx.installation),
      abortSignal: ctx.abortSignal,
    })
    if (read.state !== 'available') return read
    ctx.abortSignal.throwIfAborted()
    const session = await readSessionMetadata(read.canonicalPath)
    if (record.sourceSessionNativeId && session.nativeSessionId !== record.sourceSessionNativeId) {
      return { state: 'drifted', reason: 'source-native-session-identity-changed' }
    }
    // Ignore catalog title here: Source normalizer only needs native session context.
    return { state: 'available', record: { ...record, payload: { entry: read.entry, session } } }
  },
  async verify(record) {
    const result = await verifyJsonlLineSha256({
      ...(record.locator.path === undefined ? {} : { path: record.locator.path }),
      ...(record.locator.offset === undefined ? {} : { offset: record.locator.offset }),
      ...(record.fingerprint === undefined ? {} : { expectedFingerprint: record.fingerprint }),
    })
    return {
      ...result,
      checkedAt: new Date().toISOString(),
    }
  },
}

export const codexSourceDefinition: SourceDefinition = {
  manifest: codexManifest,
  detect: detectCodex,
  declareCapabilities: declareCodexCapabilities,
  rawRecovery: jsonlRawRecovery,
  async readArchivedNativeHooks(nativeSessionId, ctx) {
    ctx.abortSignal.throwIfAborted()
    const inbox = codexRuntimeInternals.inboxDirectory()
    const archive = await readArchivedHookInboxSession({ inbox, nativeSessionId, limit: 16 })
    const records = archive.map(item => {
      const envelope = codexRuntimeInternals.parseEnvelope(item.content, item.fileName)
      const archivePath = join(inbox, 'archive',
        createHash('sha256').update(nativeSessionId).digest('hex'), item.fileName)
      const record = codexRuntimeInternals.sourceRecordFromEnvelope(envelope, archivePath, ctx)
      if (record.sourceSessionNativeId !== nativeSessionId
        || record.sourceId !== 'codex' || record.installationId !== ctx.installation.id) {
        throw new Error('Archived Codex Hook does not belong to requested native session')
      }
      return record
    })
    ctx.abortSignal.throwIfAborted()
    return records
  },
  async *discoverNativeSessions(ctx) {
    const paths = await listCodexHistoryFiles(ctx.installation, ctx.historyWindow)
    for (const filePath of paths) {
      ctx.abortSignal.throwIfAborted()
      try {
        const before = await stat(filePath)
        if (!before.isFile()) continue
        const session = await readSessionMetadata(filePath)
        const after = await stat(filePath)
        if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
          || before.size !== after.size || before.mtimeMs !== after.mtimeMs) continue
        yield {
          sourceId: 'codex',
          installationId: ctx.installation.id,
          nativeSessionId: session.nativeSessionId,
          locationKind: 'native' as const,
          filePath,
          fileIdentity: `${after.dev}:${after.ino}`,
          fileSize: after.size,
          fileMtimeMs: after.mtimeMs,
          lastActivityAt: new Date(after.mtimeMs).toISOString(),
          ...(session.title ? { title: session.title } : {}),
          updatedAt: new Date().toISOString(),
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      }
    }
  },
  async readNativeSessionPage(query, ctx) {
    const page = await readNativeSessionWindow({
      path: query.filePath,
      allowedRoots: codexHistoryRoots(ctx.installation),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      signal: ctx.abortSignal,
    })
    if (page.state !== 'available') return page
    ctx.abortSignal.throwIfAborted()
    const session = await readSessionMetadata(query.filePath)
    if (session.nativeSessionId !== query.nativeSessionId) {
      return { state: 'drifted', reason: 'native-session-identity-changed' }
    }
    const records = page.lines.map(line => {
      const entry = line.entry
      const nativeId = nativeIdForEntry(entry)
      const nativeType = nativeTypeForEntry(entry)
      const occurredAt = typeof entry.timestamp === 'string' ? entry.timestamp
        : entry.type === 'session_meta' ? session.startedAt : undefined
      const recordHash = createHash('sha256')
        .update(`${session.nativeSessionId}|${line.sequence}|${line.textFingerprint}`).digest('hex').slice(0, 32)
      return {
        id: `codex-record-${recordHash}`,
        sourceId: 'codex',
        installationId: ctx.installation.id,
        sourceSessionNativeId: session.nativeSessionId,
        nativeType,
        ...(nativeId ? { nativeId } : {}),
        sourceSequence: line.sequence,
        ...(occurredAt ? { occurredAt } : {}),
        capturedAt: new Date().toISOString(),
        locator: { kind: 'file' as const, path: query.filePath, offset: line.offset },
        fingerprint: line.textFingerprint,
        payload: { entry, session },
        parserVersion: CODEX_CURRENT_PARSER_VERSION,
      }
    })
    return {
      state: 'available',
      records,
      recordCursors: page.lines.map(line => ({
        offset: line.offset, sequence: line.sequence - 1,
        fileIdentity: page.nextCursor.fileIdentity,
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      pendingTail: page.pendingTail,
    }
  },
  discoverAssets: discoverCodexAssets,
  ingestHistory: ingestCurrentCodexHistory,
  startCapture: startCodexRuntimeCapture,
  normalize: async (record, ctx) => normalizeCodexSessionAttribution(
    record,
    ctx,
    await normalizeCurrentCodexRecord(record, ctx),
  ),
}

const applyCodexSource = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.sources.register(codexSourceDefinition)
    return () => registration.dispose()
  },
  { inject: ['sources'] },
)

export const codexSourcePlugin = defineAgentLensPlugin(codexManifest, applyCodexSource)

export * from './assets'
export * from './config'
export * from './current-protocol'
export * from './detect'
export * from './format'
export * from './history'
export * from './instructions'
export * from './normalize'
export * from './runtime'
export * from './session-attribution'
