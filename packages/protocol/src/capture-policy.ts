import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type CapturePolicyManagedByDto = 'default' | 'file' | 'environment' | 'runtime'

export interface CapturePolicySourceSettingsDto {
  effectiveEnabledSources: string[]
  configuredEnabledSources: string[]
  managedBy: CapturePolicyManagedByDto
  editable: boolean
  restartRequired: boolean
}

export interface CapturePolicyResponseDto {
  settings: CapturePolicySourceSettingsDto
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}

export interface CapturePolicySourceUpdateRequestDto {
  enabledSources: string[]
}
