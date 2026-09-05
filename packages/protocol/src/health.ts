import { AGENT_LENS_PROTOCOL_VERSION, type JsonValue } from './timeline'

export type RuntimeOwnerDto = 'cli' | 'service' | 'desktop' | 'unknown'
export type RuntimeModeDto = 'foreground' | 'managed'

export interface RuntimeHealthDto {
  owner: RuntimeOwnerDto
  mode: RuntimeModeDto
  pid: number
  startedAt: string
}

export interface DataRuntimeWorkerHealthDto {
  state: 'starting' | 'ready' | 'degraded' | 'stopped'
  role: 'writer' | 'reader'
  protocolVersion: number
  pending: number
  maxPending: number
  requests: number
  completed: number
  timeouts: number
  lastError?: string
  durationMs: {
    last: number
    max: number
    p50: number
    p95: number
    p99: number
  }
}

export interface DataRuntimeHealthDto {
  ok: boolean
  recovering: boolean
  writer: DataRuntimeWorkerHealthDto
  reader: DataRuntimeWorkerHealthDto
}

export interface HealthResponseDto {
  status: 'ok' | 'degraded'
  protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
  runtime?: RuntimeHealthDto
  /** May also be mirrored in storage.details for backwards-compatible clients. */
  dataRuntime?: DataRuntimeHealthDto
  storage: {
    ok: boolean
    schemaVersion?: number
    details?: { [key: string]: JsonValue }
  }
}
