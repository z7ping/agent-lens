import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type IntegrationPackageCompatibilityDto = 'compatible' | 'incompatible' | 'unknown'
export type IntegrationPackageIntegrityDto = 'verified' | 'invalid' | 'unknown'
export type IntegrationPackageOperationKindDto = 'install' | 'remove' | 'update'
export type IntegrationPackageOperationStatusDto = 'queued' | 'running' | 'failed' | 'completed'

export interface IntegrationPackageCatalogItemDto {
  integrationId: string
  productId: string
  displayName: string
  packageName: string
  availableVersion?: string | undefined
  apiVersion: string
  source: 'bundled'
}

export interface IntegrationPackageStateDto {
  integrationId: string
  installed: boolean
  installedVersion?: string | undefined
  availableVersion?: string | undefined
  compatibility: IntegrationPackageCompatibilityDto
  integrity: IntegrationPackageIntegrityDto
  restartRequired: boolean
  reason?: string | undefined
}

export interface IntegrationPackageOperationDto {
  operationId: string
  integrationId: string
  kind: IntegrationPackageOperationKindDto
  status: IntegrationPackageOperationStatusDto
  startedAt: string
  completedAt?: string | undefined
  errorCode?: string | undefined
  message?: string | undefined
}

export interface IntegrationPackageCatalogResponseDto {
  catalog: IntegrationPackageCatalogItemDto[]
  states: IntegrationPackageStateDto[]
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}

export interface IntegrationPackageStateResponseDto {
  state: IntegrationPackageStateDto
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}

export interface IntegrationPackageOperationResponseDto {
  operation: IntegrationPackageOperationDto
  state: IntegrationPackageStateDto
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
    generatedAt: string
  }
}
