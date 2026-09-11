export const INTEGRATION_PACKAGE_SCHEMA_VERSION = 1 as const

export type IntegrationPackageCompatibility = 'compatible' | 'incompatible' | 'unknown'
export type IntegrationPackageIntegrity = 'verified' | 'invalid' | 'unknown'
export type IntegrationPackageOperationKind = 'install' | 'remove' | 'update'
export type IntegrationPackageOperationStatus = 'queued' | 'running' | 'failed' | 'completed'

export interface IntegrationPackageFileManifest {
  path: string
  size: number
  sha256: string
}

export interface IntegrationPackageManifest {
  schemaVersion: typeof INTEGRATION_PACKAGE_SCHEMA_VERSION
  integrationId: string
  productId: string
  packageName: string
  version: string
  apiVersion: string
  entry: string
  entryExport: 'default'
  files: IntegrationPackageFileManifest[]
}

export interface BundledIntegrationCatalogEntry {
  integrationId: string
  productId: string
  packageName: string
  version: string
  relativeManifestPath: string
  manifestSha256: string
}

export interface BundledIntegrationCatalog {
  schemaVersion: typeof INTEGRATION_PACKAGE_SCHEMA_VERSION
  entries: BundledIntegrationCatalogEntry[]
}

export interface IntegrationPackageState {
  integrationId: string
  installed: boolean
  installedVersion?: string | undefined
  availableVersion?: string | undefined
  compatibility: IntegrationPackageCompatibility
  integrity: IntegrationPackageIntegrity
  restartRequired: boolean
  entryPath?: string | undefined
  reason?: string | undefined
}

export interface IntegrationPackageOperation {
  operationId: string
  integrationId: string
  kind: IntegrationPackageOperationKind
  status: IntegrationPackageOperationStatus
  startedAt: string
  completedAt?: string | undefined
  errorCode?: string | undefined
  message?: string | undefined
}

export interface IntegrationPackageCatalogItem {
  integrationId: string
  productId: string
  displayName: string
  packageName: string
  availableVersion?: string | undefined
  apiVersion: string
  source: 'bundled'
}
