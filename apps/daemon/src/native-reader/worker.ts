import { parentPort } from 'node:worker_threads'
import type { SourceCheckpointService, SourceDefinition } from '@agent-lens/core'
import { piSourceDefinition } from '@agent-lens/source-pi'
import { codexSourceDefinition } from '@agent-lens/source-codex'
import { claudeSourceDefinition } from '@agent-lens/source-claude'
import { hermesSourceDefinition } from '@agent-lens/source-hermes'
import { openCodeSourceDefinition } from '@agent-lens/source-opencode'
import type {
  NativeWorkerReadInput,
  NativeWorkerReadResult,
  NativeWorkerHookReadInput,
  NativeWorkerHookReadResult,
  NativeWorkerRequest,
  NativeWorkerReply,
} from '@agent-lens/core-services'

if (!parentPort) throw new Error('Native Reader Worker requires a parent port')

const channel = parentPort
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const sources = new Map<string, SourceDefinition>([
  [piSourceDefinition.manifest.sourceId, piSourceDefinition],
  [codexSourceDefinition.manifest.sourceId, codexSourceDefinition],
  [claudeSourceDefinition.manifest.sourceId, claudeSourceDefinition],
  [hermesSourceDefinition.manifest.sourceId, hermesSourceDefinition],
  [openCodeSourceDefinition.manifest.sourceId, openCodeSourceDefinition],
])
const aborts = new Map<number, AbortController>()
const checkpoint: SourceCheckpointService = {
  async get() { return null },
  async set() { throw new Error('Native Reader Worker cannot modify checkpoints') },
  async clear() { throw new Error('Native Reader Worker cannot clear checkpoints') },
}

async function read(input: NativeWorkerReadInput, signal: AbortSignal): Promise<NativeWorkerReadResult> {
  const source = sources.get(input.sourceId)
  if (!source?.readNativeSessionPage) {
    return { state: 'unsupported', reason: 'source-not-supported-by-native-worker' }
  }
  if (input.parserVersion !== source.manifest.parserVersion) {
    return { state: 'unsupported', reason: 'native-worker-parser-version-mismatch' }
  }
  if (!input.query.nativeSessionId || input.query.nativeSessionId.length > 512
    || !input.host.id || input.installation.hostId !== input.host.id
    || input.installation.productId !== source.manifest.productId
    || !input.installation.id
    || (input.query.limit !== undefined
      && (!Number.isSafeInteger(input.query.limit) || input.query.limit < 1 || input.query.limit > 64))) {
    return { state: 'unsupported', reason: 'native-worker-request-invalid' }
  }
  signal.throwIfAborted()
  // Installation roots are the ONLY authoritative path allowlist, validated
  // again by each Source adapter. The requested absolute path was looked up in
  // the parent Reader from the trusted local Session Catalog.
  const ctx = {
    host: input.host,
    installation: input.installation,
    abortSignal: signal,
    checkpoint,
  }
  const page = await source.readNativeSessionPage(input.query, ctx)
  if (page.state !== 'available') return page
  if (page.nextCursor.fileIdentity !== input.expectedFileIdentity) {
    return { state: 'drifted', reason: 'native-catalog-file-identity-changed' }
  }
  if (page.recordCursors && page.recordCursors.length !== page.records.length) {
    return { state: 'unsupported', reason: 'native-worker-record-cursors-mismatch' }
  }
  if (page.records.length > 64) {
    return { state: 'unsupported', reason: 'native-worker-record-limit' }
  }
  const entries: Extract<NativeWorkerReadResult, {state: 'available'}>['entries'] = []
  for (const [index, record] of page.records.entries()) {
    signal.throwIfAborted()
    if (record.sourceId !== input.sourceId || record.installationId !== input.installation.id
      || record.sourceSessionNativeId !== input.query.nativeSessionId) {
      return { state: 'drifted', reason: 'native-worker-record-identity-changed' }
    }
    const normalized = await source.normalize(record, {
      host: input.host,
      installation: input.installation,
    })
    entries.push({
      recordId: record.id,
      ...(page.recordCursors?.[index] ? { recordCursor: page.recordCursors[index] } : {}),
      sourceId: record.sourceId,
      installationId: record.installationId,
      ...(record.sourceSessionNativeId ? { sourceSessionNativeId: record.sourceSessionNativeId } : {}),
      normalized,
    })
  }
  signal.throwIfAborted()
  const result: NativeWorkerReadResult = {
    state: 'available', entries,
    nextCursor: page.nextCursor, hasMore: page.hasMore,
    pendingTail: page.pendingTail,
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESPONSE_BYTES) {
    return { state: 'unsupported', reason: 'native-worker-response-too-large' }
  }
  return result
}

async function readHooks(
  input: NativeWorkerHookReadInput,
  signal: AbortSignal,
): Promise<NativeWorkerHookReadResult> {
  const source = sources.get(input.sourceId)
  if (!source?.readArchivedNativeHooksPage) {
    return {state:'unsupported',reason:'source-not-supported-by-hook-worker'}
  }
  if (source.manifest.parserVersion !== input.parserVersion) {
    return {state:'unsupported',reason:'native-worker-parser-version-mismatch'}
  }
  if (!input.nativeSessionId || input.nativeSessionId.length > 512
    || !input.host.id || !input.installation.id
    || input.installation.hostId !== input.host.id
    || input.installation.productId !== source.manifest.productId
    || (input.cursor !== undefined && (!input.cursor || input.cursor.length > 512
      || !/^[A-Za-z0-9_-]+$/.test(input.cursor)))) {
    return {state:'unsupported',reason:'native-worker-request-invalid'}
  }
  signal.throwIfAborted()
  let page: Awaited<ReturnType<NonNullable<SourceDefinition['readArchivedNativeHooksPage']>>>
  try {
    page = await source.readArchivedNativeHooksPage(input.nativeSessionId, {
      host: input.host, installation: input.installation, checkpoint, abortSignal: signal,
    }, input.cursor)
  } catch (error) {
    if (error instanceof TypeError && error.message === 'Invalid archived Hook cursor') {
      return {state:'unsupported',reason:'native-hook-cursor-invalid'}
    }
    throw error
  }
  if (page.records.length > 16
    || (page.hasMore && (!page.records.length || !page.nextCursor
      || page.nextCursor === input.cursor || page.nextCursor.length > 512
      || !/^[A-Za-z0-9_-]+$/.test(page.nextCursor)))
    || (!page.hasMore && page.nextCursor)) {
    return {state:'unsupported',reason:'native-hook-page-invalid'}
  }
  const entries: Extract<NativeWorkerHookReadResult,{state:'available'}>['entries'] = []
  for (const record of page.records) {
    signal.throwIfAborted()
    if (record.sourceId !== input.sourceId
      || record.installationId !== input.installation.id
      || record.sourceSessionNativeId !== input.nativeSessionId
      || record.locator.kind !== 'runtime-hook') {
      return {state:'drifted',reason:'native-hook-record-identity-drifted'}
    }
    entries.push({
      recordId: record.id,
      sourceId: record.sourceId,
      installationId: record.installationId,
      sourceSessionNativeId: input.nativeSessionId,
      normalized: await source.normalize(record, {
        host: input.host, installation: input.installation,
      }),
    })
  }
  const result: NativeWorkerHookReadResult = {
    state:'available',entries,hasMore:page.hasMore,
    ...(page.nextCursor ? {nextCursor:page.nextCursor} : {}),
  }
  try {
    if (Buffer.byteLength(JSON.stringify(result),'utf8') > MAX_RESPONSE_BYTES) {
      return {state:'unsupported',reason:'native-hook-worker-response-too-large'}
    }
  } catch {
    return {state:'unsupported',reason:'native-hook-worker-response-not-serializable'}
  }
  return result
}

channel.on('message', (request: NativeWorkerRequest) => {
  if (request.kind === 'cancel') {
    aborts.get(request.id)?.abort()
    return
  }
  if ((request.kind !== 'read' && request.kind !== 'read-hooks')
    || !Number.isSafeInteger(request.id)) return
  const controller = new AbortController()
  aborts.set(request.id, controller)
  if (request.kind === 'read-hooks') {
    void readHooks(request.input, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) {
          channel.postMessage({kind:'hook-reply',id:request.id,result} satisfies NativeWorkerReply)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          channel.postMessage({
            kind:'hook-reply',id:request.id,
            result:{state:'unsupported',reason:'native-hook-worker-read-failed'},
          } satisfies NativeWorkerReply)
        }
      })
      .finally(() => aborts.delete(request.id))
    return
  }
  void read(request.input, controller.signal)
    .then(result => {
      if (!controller.signal.aborted) {
        channel.postMessage({ kind: 'reply', id: request.id, result } satisfies NativeWorkerReply)
      }
    })
    .catch(() => {
      if (!controller.signal.aborted) {
        channel.postMessage({
          kind: 'reply', id: request.id,
          result: { state: 'unsupported', reason: 'native-worker-read-failed' },
        } satisfies NativeWorkerReply)
      }
    })
    .finally(() => aborts.delete(request.id))
})
