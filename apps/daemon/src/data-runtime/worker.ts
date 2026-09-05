import { randomUUID } from 'node:crypto'
import { parentPort, threadId, workerData } from 'node:worker_threads'
import {
  HubUnifiedLogicalSessionReader,
  HubUnifiedObservationReader,
  SqliteHubRemoteReadRepository,
  SqliteStorageService,
} from '@agent-lens/storage-sqlite'
import {
  DATA_RUNTIME_MAX_MESSAGE_BYTES,
  DATA_RUNTIME_PROTOCOL_VERSION,
  encodedMessageBytes,
  type DataRuntimeErrorResponse,
  type DataRuntimeRequest,
  type DataRuntimeResponse,
  type DataRuntimeRole,
} from './protocol.js'

if (!parentPort) throw new Error('Data Runtime worker requires parentPort')

interface DataRuntimeWorkerData {
  allowDiagnostics?: boolean
  role?: DataRuntimeRole
  dbPath?: string
  nodeId?: string
}

const config = (workerData ?? {}) as DataRuntimeWorkerData
const startedAt = Date.now()
const allowDiagnostics = Boolean(config.allowDiagnostics)
const role: DataRuntimeRole = config.role ?? 'writer'
const dbPath = config.dbPath
const nodeId = config.nodeId ?? 'local'
let storage: SqliteStorageService | null = null
let unifiedRead: {
  logicalSessions: HubUnifiedLogicalSessionReader
  observations: HubUnifiedObservationReader
} | null = null
let activeTransactionId: string | null = null
let requestTail: Promise<void> = Promise.resolve()

if (dbPath) {
  storage = new SqliteStorageService({ path: dbPath, readonly: role === 'reader' })
  if (role === 'writer') await storage.migrate()
  const remote = new SqliteHubRemoteReadRepository(storage.executor)
  const logicalSessions = new HubUnifiedLogicalSessionReader(
    nodeId,
    storage.repositories.sessions,
    remote,
    storage.sessionSummaries,
  )
  unifiedRead = {
    logicalSessions,
    observations: new HubUnifiedObservationReader(
      nodeId,
      storage.repositories.observations,
      logicalSessions,
      remote,
    ),
  }
}

function reply(requestId: string, result: unknown): void {
  const message: DataRuntimeResponse = {
    protocolVersion: DATA_RUNTIME_PROTOCOL_VERSION,
    type: 'response',
    requestId,
    result,
  }
  parentPort!.postMessage(message)
}

function fail(requestId: string, code: string, message: string): void {
  const response: DataRuntimeErrorResponse = {
    protocolVersion: DATA_RUNTIME_PROTOCOL_VERSION,
    type: 'error',
    requestId,
    error: { code, message: message.slice(0, 1000) },
  }
  parentPort!.postMessage(response)
}

function validRequest(value: unknown): value is DataRuntimeRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.protocolVersion === DATA_RUNTIME_PROTOCOL_VERSION
    && record.type === 'request'
    && typeof record.requestId === 'string'
    && typeof record.method === 'string'
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > 8
    || value.some(item => typeof item !== 'string' || !item || ['__proto__', 'prototype', 'constructor'].includes(item))) {
    throw new TypeError(`${name} must be a safe non-empty path`)
  }
  return value as string[]
}

function argsArray(value: unknown): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError('args must be an array')
  return value
}

function storageRootAllowed(path: readonly string[]): boolean {
  return [
    'repositories',
    'checkpoints',
    'assetInventory',
    'sessionSummaries',
    'sessionSummaryProjection',
    'toolUsageObservations',
    'unknownObservationProjection',
    'maintenance',
    'maintenanceJobs',
    'projectionBackfill',
    'runtimeProfiles',
    'sourceRuntimeStatus',
    'sessionRelationshipCandidates',
    'replication',
    'replicationCanonicalChanges',
    'health',
    'diagnostics',
  ].includes(path[0]!)
}

async function invoke(root: unknown, path: readonly string[], args: readonly unknown[]): Promise<unknown> {
  let parent: any = null
  let current: any = root
  for (const segment of path) {
    parent = current
    current = current?.[segment]
  }
  if (typeof current !== 'function') throw new TypeError(`RPC target is not callable: ${path.join('.')}`)
  return current.apply(parent, args)
}

function requireStorage(): SqliteStorageService {
  if (!storage) throw new Error('Data Runtime storage is not configured')
  return storage
}

function transactionId(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

async function handleRequest(value: unknown): Promise<void> {
  if (encodedMessageBytes(value) > DATA_RUNTIME_MAX_MESSAGE_BYTES) {
    const requestId = value && typeof value === 'object' && 'requestId' in value
      ? String((value as { requestId?: unknown }).requestId ?? 'unknown')
      : 'unknown'
    fail(requestId, 'message_too_large', 'Data Runtime IPC message exceeds size limit')
    return
  }
  if (!validRequest(value)) {
    fail('unknown', 'invalid_request', 'Invalid Data Runtime IPC request')
    return
  }

  try {
    if (value.method === 'ping' || value.method === 'status') {
      reply(value.requestId, {
        ok: true,
        role,
        storageConfigured: Boolean(storage),
        protocolVersion: DATA_RUNTIME_PROTOCOL_VERSION,
        threadId,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        inTransaction: Boolean(activeTransactionId),
      })
      return
    }

    if (value.method === 'diagnostic.block') {
      if (!allowDiagnostics) {
        fail(value.requestId, 'forbidden', 'Diagnostic blocking is disabled')
        return
      }
      const requested = Number(value.params?.durationMs ?? 0)
      const durationMs = Math.max(0, Math.min(Number.isFinite(requested) ? requested : 0, 2_000))
      const deadline = performance.now() + durationMs
      while (performance.now() < deadline) {
        // Intentional synchronous worker-only busy loop for isolation regression tests.
      }
      reply(value.requestId, { blockedMs: durationMs })
      return
    }

    if (value.method === 'diagnostic.exit') {
      if (!allowDiagnostics) {
        fail(value.requestId, 'forbidden', 'Diagnostic exit is disabled')
        return
      }
      reply(value.requestId, { exiting: true })
      setImmediate(() => process.exit(23))
      return
    }

    if (value.method === 'storage.transaction.begin') {
      const local = requireStorage()
      if (role !== 'writer') throw new Error('Read-only Data Runtime cannot begin a write transaction')
      if (activeTransactionId) throw new Error('Data Runtime transaction is already active')
      const id = randomUUID()
      await local.executor.beginExternalTransaction()
      activeTransactionId = id
      reply(value.requestId, { transactionId: id })
      return
    }

    if (value.method === 'storage.transaction.commit' || value.method === 'storage.transaction.rollback') {
      const local = requireStorage()
      const requestedId = transactionId(value.params?.transactionId)
      if (!requestedId || requestedId !== activeTransactionId) {
        throw new Error('Data Runtime transaction ownership mismatch')
      }
      if (value.method === 'storage.transaction.commit') local.executor.commitExternalTransaction()
      else local.executor.rollbackExternalTransaction()
      activeTransactionId = null
      reply(value.requestId, { ok: true })
      return
    }

    if (value.method === 'storage.call') {
      const local = requireStorage()
      const path = stringArray(value.params?.path, 'path')
      if (!storageRootAllowed(path)) throw new Error(`Storage RPC root is not allowed: ${path[0]}`)
      const requestedId = transactionId(value.params?.transactionId)
      if (activeTransactionId && requestedId !== activeTransactionId) {
        throw new Error('Data Runtime storage call cannot cross an active transaction')
      }
      if (!activeTransactionId && requestedId) throw new Error('Data Runtime transaction is not active')
      reply(value.requestId, await invoke(local, path, argsArray(value.params?.args)))
      return
    }

    if (value.method === 'unified-read.call') {
      if (!unifiedRead) throw new Error('Data Runtime unified read is not configured')
      if (activeTransactionId) throw new Error('Unified read cannot enter an active write transaction')
      const path = stringArray(value.params?.path, 'path')
      if (!['logicalSessions', 'observations'].includes(path[0]!)) {
        throw new Error(`Unified read RPC root is not allowed: ${path[0]}`)
      }
      reply(value.requestId, await invoke(unifiedRead, path, argsArray(value.params?.args)))
      return
    }

    if (value.method === 'shutdown') {
      if (storage) {
        if (activeTransactionId) {
          storage.executor.rollbackExternalTransaction()
          activeTransactionId = null
        }
        await storage.close()
        storage = null
      }
      reply(value.requestId, { ok: true })
      setImmediate(() => parentPort!.close())
      return
    }

    fail(value.requestId, 'method_not_found', `Unknown Data Runtime method: ${value.method}`)
  } catch (error) {
    fail(value.requestId, 'internal_error', error instanceof Error ? error.message : String(error))
  }
}

parentPort.on('message', value => {
  const task = requestTail.then(
    () => handleRequest(value),
    () => handleRequest(value),
  )
  requestTail = task.then(() => undefined, () => undefined)
})
