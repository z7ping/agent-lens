import { AGENT_LENS_PROTOCOL_VERSION, type JsonValue } from './timeline'

export type RuntimeOwnerDto = 'cli' | 'service' | 'desktop' | 'unknown'
export type RuntimeModeDto = 'foreground' | 'managed'

export interface RuntimeHealthDto {
  owner: RuntimeOwnerDto
  mode: RuntimeModeDto
  pid: number
  startedAt: string
}

export interface HealthResponseDto {
  status: 'ok' | 'degraded'
  protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
  runtime: RuntimeHealthDto
  storage: {
    ok: boolean
    schemaVersion?: number
    details?: { [key: string]: JsonValue }
  }
}
