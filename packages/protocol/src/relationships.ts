import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export interface SessionRelationshipDto {
  id: string
  sourceId?: string
  fromSessionId: string
  toSessionId: string
  type: 'resume' | 'continuation' | 'fork' | 'subagent' | 'import-copy' | 'related' | 'native-parent'
  confidence: 'exact' | 'high' | 'medium' | 'low' | 'unknown'
  fromNativeSessionId?: string
  toNativeSessionId?: string
}

export interface SessionRelationshipResponseDto {
  items: SessionRelationshipDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}
