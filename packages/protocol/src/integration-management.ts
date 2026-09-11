import type { CapturePolicyManagedByDto } from './capture-policy'
import type {
  IntegrationDiscoveryScanStatusDto,
  IntegrationToolDiscoveryItemDto,
} from './integration-discovery'
import type { AgentIntegrationCapabilityStatusDto } from './overview'
import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export interface IntegrationOnboardingPreferenceDto {
  completed: boolean
  completedAt?: string | undefined
}

export interface IntegrationPreferencesDto {
  onboarding: IntegrationOnboardingPreferenceDto
  displayOrder: string[]
  acknowledgedIntegrationIds: string[]
  updatedAt: string
}

export interface IntegrationPreferenceUpdateRequestDto {
  onboardingCompleted?: boolean | undefined
  displayOrder?: string[] | undefined
  acknowledgedIntegrationIds?: string[] | undefined
}

export type IntegrationPackageSourceDto = 'bundled' | 'managed'
export type IntegrationPackageCompatibilityDto = 'compatible' | 'incompatible' | 'unknown'

export interface IntegrationPackageStateDto {
  installed: boolean
  source: IntegrationPackageSourceDto
  installedVersion?: string | undefined
  availableVersion?: string | undefined
  compatibility: IntegrationPackageCompatibilityDto
  restartRequired: boolean
}

export interface IntegrationEnabledStateDto {
  configured: boolean
  effective: boolean
  editable: boolean
  managedBy: CapturePolicyManagedByDto
  restartRequired: boolean
}

export interface IntegrationManagementItemDto {
  integrationId: string
  productId: string
  displayName: string
  tool?: IntegrationToolDiscoveryItemDto | undefined
  package: IntegrationPackageStateDto
  enabled: IntegrationEnabledStateDto
  availability: 'available' | 'partial' | 'unavailable' | 'error'
  capabilities: AgentIntegrationCapabilityStatusDto[]
  isNew: boolean
  displayOrder: number
}

export interface IntegrationManagementResponseDto {
  items: IntegrationManagementItemDto[]
  discovery: {
    status: IntegrationDiscoveryScanStatusDto
    startedAt?: string | undefined
    completedAt?: string | undefined
    generatedAt: string
  }
  preferences: IntegrationPreferencesDto
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}

export interface IntegrationEnabledUpdateRequestDto {
  enabled: boolean
}

export interface IntegrationEnabledUpdateResponseDto {
  integrationId: string
  enabled: IntegrationEnabledStateDto
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}

export interface IntegrationPreferencesResponseDto {
  preferences: IntegrationPreferencesDto
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}
