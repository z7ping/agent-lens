import { AGENT_LENS_PROTOCOL_VERSION, type JsonValue } from './timeline'

export type RuntimeOwnerDto = 'cli' | 'service' | 'desktop' | 'unknown'
export type RuntimeModeDto = 'foreground' | 'managed'

export interface RuntimeHealthDto {
  owner: RuntimeOwnerDto
  mode: RuntimeModeDto
  pid: number
  startedAt: string
}

export interface DataRuntimeHealthDto {
  state: 'starting' | 'ready' | 'degraded' | 'stopped' | 'not-started'
  protocolVersion?: number
  pending?: number
  maxPending?: number
  requests?: number
  completed?: number
  timeouts?: number
  lastError?: string
  durationMs?: {
    last: number
    max: number
    p50: number
    p95: number
    p99: number
  }
}

export interface HealthResponseDto {
  status: 'ok' | 'degraded'
  protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
  runtime?: RuntimeHealthDto
  dataRuntime?: DataRuntimeHealthDto
  storage: {
    ok: boolean
    schemaVersion?: number
    details?: { [key: string]: JsonValue }
  }
}
