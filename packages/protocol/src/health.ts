import { AGENT_LENS_PROTOCOL_VERSION, type JsonValue } from './timeline'

export interface HealthResponseDto {
  status: 'ok' | 'degraded'
  protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
  storage: {
    ok: boolean
    schemaVersion?: number
    details?: { [key: string]: JsonValue }
  }
}
