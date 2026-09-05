import { parentPort, threadId, workerData } from 'node:worker_threads'
import {
  DATA_RUNTIME_MAX_MESSAGE_BYTES,
  DATA_RUNTIME_PROTOCOL_VERSION,
  encodedMessageBytes,
  type DataRuntimeErrorResponse,
  type DataRuntimeRequest,
  type DataRuntimeResponse,
} from './protocol.js'

if (!parentPort) throw new Error('Data Runtime worker requires parentPort')

const startedAt = Date.now()
const allowDiagnostics = Boolean((workerData as { allowDiagnostics?: boolean } | undefined)?.allowDiagnostics)

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

parentPort.on('message', async value => {
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
        protocolVersion: DATA_RUNTIME_PROTOCOL_VERSION,
        threadId,
        startedAt,
        uptimeMs: Date.now() - startedAt,
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

    if (value.method === 'shutdown') {
      reply(value.requestId, { ok: true })
      setImmediate(() => parentPort!.close())
      return
    }

    fail(value.requestId, 'method_not_found', `Unknown Data Runtime method: ${value.method}`)
  } catch (error) {
    fail(value.requestId, 'internal_error', error instanceof Error ? error.message : String(error))
  }
})
