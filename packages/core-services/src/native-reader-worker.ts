import { parentPort } from 'node:worker_threads'
import type { SourceCheckpointService, SourceDefinition } from '@agent-lens/core'
import { piSourceDefinition } from '@agent-lens/source-pi'
import { codexSourceDefinition } from '@agent-lens/source-codex'
import type {
  NativeWorkerReadInput,
  NativeWorkerReadResult,
  NativeWorkerRequest,
  NativeWorkerReply,
} from './native-reader-worker-protocol'

if (!parentPort) throw new Error('Native Reader Worker requires a parent port')

const channel = parentPort
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const sources = new Map<string, SourceDefinition>([
  [piSourceDefinition.manifest.sourceId, piSourceDefinition],
  [codexSourceDefinition.manifest.sourceId, codexSourceDefinition],
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
  if (page.records.length > 64) {
    return { state: 'unsupported', reason: 'native-worker-record-limit' }
  }
  const entries: Extract<NativeWorkerReadResult, {state: 'available'}>['entries'] = []
  for (const record of page.records) {
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

channel.on('message', (request: NativeWorkerRequest) => {
  if (request.kind === 'cancel') {
    aborts.get(request.id)?.abort()
    return
  }
  if (request.kind !== 'read' || !Number.isSafeInteger(request.id)) return
  const controller = new AbortController()
  aborts.set(request.id, controller)
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
