export const DATA_RUNTIME_PROTOCOL_VERSION = 1
export const DATA_RUNTIME_MAX_MESSAGE_BYTES = 256 * 1024
export const DATA_RUNTIME_MAX_PENDING_REQUESTS = 64
export const DATA_RUNTIME_DEFAULT_TIMEOUT_MS = 5_000

export type DataRuntimeRole = 'writer' | 'reader'

export type DataRuntimeMethod =
  | 'ping'
  | 'status'
  | 'shutdown'
  | 'diagnostic.block'
  | 'storage.call'
  | 'storage.transaction.begin'
  | 'storage.transaction.commit'
  | 'storage.transaction.rollback'
  | 'unified-read.call'

export interface DataRuntimeRequest {
  protocolVersion: number
  type: 'request'
  requestId: string
  method: DataRuntimeMethod
  params?: Record<string, unknown>
}

export interface DataRuntimeResponse {
  protocolVersion: number
  type: 'response'
  requestId: string
  result: unknown
}

export interface DataRuntimeErrorResponse {
  protocolVersion: number
  type: 'error'
  requestId: string
  error: {
    code: string
    message: string
  }
}

export type DataRuntimeMessage = DataRuntimeRequest | DataRuntimeResponse | DataRuntimeErrorResponse

export function encodedMessageBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export function isDataRuntimeReply(value: unknown): value is DataRuntimeResponse | DataRuntimeErrorResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.protocolVersion === DATA_RUNTIME_PROTOCOL_VERSION
    && (record.type === 'response' || record.type === 'error')
    && typeof record.requestId === 'string'
}
