import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type IntegrationToolPresenceDto = 'present' | 'data-only' | 'absent' | 'error'
export type IntegrationDiscoveryScanStatusDto = 'idle' | 'scanning' | 'complete'

export interface IntegrationToolDiscoveryItemDto {
  integrationId: string
  productId: string
  displayName: string
  presence: IntegrationToolPresenceDto
  executable?: string | undefined
  configRoot?: string | undefined
  dataRoot?: string | undefined
  reason?: string | undefined
}

export interface IntegrationToolDiscoveryResponseDto {
  status: IntegrationDiscoveryScanStatusDto
  items: IntegrationToolDiscoveryItemDto[]
  startedAt?: string | undefined
  completedAt?: string | undefined
  generatedAt: string
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
  }
}
