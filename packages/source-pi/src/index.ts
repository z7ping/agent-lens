import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
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
import { readAuthorizedNativeJsonlEntry, readNativeSessionWindow, verifyJsonlLineSha256 } from '@agent-lens/source-support'
import { discoverPiAssets, piAssetInternals } from './assets'
import { PI_PARSER_VERSION, PI_SOURCE_ID } from './constants'
import { normalizePiRecord } from './normalize'
import {
  detectPi,
  ingestPiHistory,
  listJsonlFiles,
  readPiSessionMetadata,
  piSessionInternals,
  startPiRuntimeCapture,
} from './session'

export async function declarePiCapabilities(
  _detected: DetectedSource,
): Promise<ObservationCapability[]> {
  return [
    { sourceId: PI_SOURCE_ID, name: 'session', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'transcript', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'tool-call', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'tool-result', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'context', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'model-change', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'thinking-level-change', status: 'available', captureModes: ['history', 'native-tail'] },
    {
      sourceId: PI_SOURCE_ID,
      name: 'asset-discovery',
      status: 'partial',
      captureModes: ['static-scan'],
      reason: 'Persisted Pi resources are resolved statically; external CLI-only and runtime extension-discovered resources require invocation/runtime evidence',
    },
    { sourceId: PI_SOURCE_ID, name: 'permission', status: 'unavailable', captureModes: [], reason: 'No stable permission event is proven in the native session log' },
    { sourceId: PI_SOURCE_ID, name: 'subagent', status: 'partial', captureModes: ['history'], reason: 'Parent session links are retained; explicit subagent lifecycle is not proven' },
    { sourceId: PI_SOURCE_ID, name: 'thinking', status: 'partial', captureModes: ['history'], reason: 'Only source-visible thinking blocks are captured' },
    { sourceId: PI_SOURCE_ID, name: 'asset-invocation', status: 'unavailable', captureModes: [], reason: 'Invocation attribution is handled by later usage projections' },
    { sourceId: PI_SOURCE_ID, name: 'usage', status: 'available', captureModes: ['history', 'native-tail'] },
    { sourceId: PI_SOURCE_ID, name: 'artifact-action', status: 'unavailable', captureModes: [], reason: 'Artifact attribution is not implemented' },
  ]
}

export const piManifest: SourcePluginManifest = {
  pluginId: '@agent-lens/source-pi',
  pluginVersion: '1.0.0-alpha.7',
  apiVersion: '1.0',
  pluginType: 'source',
  displayName: 'Pi Source',
  sourceId: PI_SOURCE_ID,
  productId: PI_SOURCE_ID,
  parserVersion: PI_PARSER_VERSION,
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
      sourceId: PI_SOURCE_ID,
      parserVersion: PI_PARSER_VERSION,
      allowedRoots: ctx.installation.dataRoot ? [ctx.installation.dataRoot] : [],
      abortSignal: ctx.abortSignal,
    })
    if (read.state !== 'available') return read
    ctx.abortSignal.throwIfAborted()
    const session = await readPiSessionMetadata(read.canonicalPath)
    if (record.sourceSessionNativeId && session.nativeSessionId !== record.sourceSessionNativeId) {
      return { state: 'drifted', reason: 'source-native-session-identity-changed' }
    }
    // Transient payload: only the existing Source normalizer receives it.
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

export const piSourceDefinition: SourceDefinition = {
  manifest: piManifest,
  detect: detectPi,
  declareCapabilities: declarePiCapabilities,
  rawRecovery: jsonlRawRecovery,
  nativeSessionCoverageComplete: true,
  async *discoverNativeSessions(ctx) {
    const root = ctx.installation.dataRoot
    if (!root) return
    const paths = await listJsonlFiles(root, ctx.historyWindow)
    for (const filePath of paths) {
      ctx.abortSignal.throwIfAborted()
      try {
        const before = await stat(filePath)
        if (!before.isFile()) continue
        const session = await readPiSessionMetadata(filePath)
        const after = await stat(filePath)
        if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
          || before.size !== after.size || before.mtimeMs !== after.mtimeMs) continue
        yield {
          sourceId: PI_SOURCE_ID,
          installationId: ctx.installation.id,
          nativeSessionId: session.nativeSessionId,
          locationKind: 'native' as const,
          filePath,
          fileIdentity: `${after.dev}:${after.ino}`,
          fileSize: after.size,
          fileMtimeMs: after.mtimeMs,
          lastActivityAt: new Date(after.mtimeMs).toISOString(),
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
      allowedRoots: ctx.installation.dataRoot ? [ctx.installation.dataRoot] : [],
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      signal: ctx.abortSignal,
    })
    if (page.state !== 'available') return page
    ctx.abortSignal.throwIfAborted()
    const session = await readPiSessionMetadata(query.filePath)
    if (session.nativeSessionId !== query.nativeSessionId) {
      return { state: 'drifted', reason: 'native-session-identity-changed' }
    }
    // Session metadata is read through a second open. A replace/rename race
    // must not splice metadata from a different inode onto verified page bytes.
    let current: Awaited<ReturnType<typeof stat>>
    try { current = await stat(query.filePath) }
    catch (error) {
      if (['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        return { state: 'drifted', reason: 'native-file-disappeared-after-page-read' }
      }
      throw error
    }
    if (!current.isFile() || `${current.dev}:${current.ino}` !== page.nextCursor.fileIdentity) {
      return { state: 'drifted', reason: 'native-file-identity-changed' }
    }
    const records = page.lines.map(line => {
      const entry = line.entry
      const nativeId = typeof entry.id === 'string' && entry.id ? entry.id : undefined
      const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp
        : typeof (entry.message as { timestamp?: unknown } | undefined)?.timestamp === 'number'
          ? new Date((entry.message as { timestamp: number }).timestamp).toISOString()
          : undefined
      const recordHash = createHash('sha256')
        .update(`${query.filePath}|${line.offset}|${line.textFingerprint}`).digest('hex').slice(0, 32)
      return {
        id: `pi-record-${recordHash}`,
        sourceId: PI_SOURCE_ID,
        installationId: ctx.installation.id,
        sourceSessionNativeId: session.nativeSessionId,
        nativeType: `history/${typeof entry.type === 'string' ? entry.type : 'unknown'}`,
        ...(nativeId ? { nativeId } : {}),
        sourceSequence: line.sequence * 1000,
        ...(timestamp ? { occurredAt: timestamp } : {}),
        capturedAt: new Date().toISOString(),
        locator: { kind: 'file' as const, path: query.filePath, offset: line.offset },
        fingerprint: line.textFingerprint,
        payload: { entry, session },
        parserVersion: PI_PARSER_VERSION,
      }
    })
    return {
      state: 'available',
      records,
      recordCursors: page.lines.map(line => ({
        offset: line.offset, sequence: line.sequence - 1,
        fileIdentity: page.nextCursor.fileIdentity,
        boundaryHash: line.boundaryHash,
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      pendingTail: page.pendingTail,
    }
  },
  discoverAssets: discoverPiAssets,
  ingestHistory: ingestPiHistory,
  startCapture: startPiRuntimeCapture,
  normalize: normalizePiRecord,
}

const applyPiSource = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.sources.register(piSourceDefinition)
    return () => registration.dispose()
  },
  { inject: ['sources'] },
)

export const piSourcePlugin = defineAgentLensPlugin(piManifest, applyPiSource)

export {
  detectPi,
  discoverPiAssets,
  ingestPiHistory,
  normalizePiRecord,
  startPiRuntimeCapture,
}

export const piInternals = {
  ...piSessionInternals,
  ...piAssetInternals,
}
