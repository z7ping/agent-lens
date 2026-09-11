import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type IntegrationAuthorizationCapabilityDto = 'hook' | 'runtime' | 'live'

export interface IntegrationAuthorizationRequestDto {
  capabilities: IntegrationAuthorizationCapabilityDto[]
}

export interface IntegrationAuthorizationResponseDto {
  productId: string
  authorizedCapabilities: IntegrationAuthorizationCapabilityDto[]
  restartRequired: boolean
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}
