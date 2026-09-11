import type {
  AgentIntegrationRuntimeStatus,
  CapturePolicyConfigurationSource,
  CapturePolicyService,
} from '@agent-lens/core'
import {
  OFFICIAL_INTEGRATION_CATALOG,
  officialIntegrationCatalogEntry,
} from '@agent-lens/integration-catalog'
import type {
  OfficialToolDiscoveryItem,
  OfficialToolDiscoverySnapshot,
} from './tool-discovery'
import {
  IntegrationPreferenceService,
  type IntegrationPreferences,
} from './integration-preferences'

export type IntegrationPackageCompatibility = 'compatible' | 'incompatible' | 'unknown'
export type IntegrationPackageSource = 'bundled' | 'managed'

export interface IntegrationPackageState {
  integrationId: string
  installed: boolean
  source: IntegrationPackageSource
  installedVersion?: string | undefined
  availableVersion?: string | undefined
  compatibility: IntegrationPackageCompatibility
  restartRequired: boolean
}

export interface IntegrationEnabledState {
  configured: boolean
  effective: boolean
  editable: boolean
  managedBy: CapturePolicyConfigurationSource
  restartRequired: boolean
}

export interface IntegrationManagementItem {
  integrationId: string
  productId: string
  displayName: string
  tool?: OfficialToolDiscoveryItem | undefined
  package: IntegrationPackageState
  enabled: IntegrationEnabledState
  availability: AgentIntegrationRuntimeStatus['availability']
  capabilities: AgentIntegrationRuntimeStatus['capabilities']
  isNew: boolean
  displayOrder: number
}

export interface IntegrationManagementSnapshot {
  items: IntegrationManagementItem[]
  discovery: Pick<
    OfficialToolDiscoverySnapshot,
    'status' | 'startedAt' | 'completedAt' | 'generatedAt'
  >
  preferences: IntegrationPreferences
  generatedAt: string
}

export interface IntegrationManagementOptions {
  discovery: {
    snapshot(): OfficialToolDiscoverySnapshot
  }
  preferences: IntegrationPreferenceService
  capturePolicy: CapturePolicyService
  integrationStatus(
    productId: string,
  ): AgentIntegrationRuntimeStatus | null | Promise<AgentIntegrationRuntimeStatus | null>
  packageState?: (
    integrationId: string,
  ) => IntegrationPackageState | Promise<IntegrationPackageState>
}

function bundledPackageState(integrationId: string): IntegrationPackageState {
  return {
    integrationId,
    installed: true,
    source: 'bundled',
    compatibility: 'compatible',
    restartRequired: false,
  }
}

function enabledState(
  integrationId: string,
  configuration: ReturnType<CapturePolicyService['getSourceConfiguration']>,
): IntegrationEnabledState {
  const configured = configuration.configuredEnabledSources.includes(integrationId)
  const effective = configuration.effectiveEnabledSources.includes(integrationId)
  return {
    configured,
    effective,
    editable: configuration.editable,
    managedBy: configuration.source,
    restartRequired: configured !== effective,
  }
}

function orderedCatalogIds(preferences: IntegrationPreferences): string[] {
  const catalogIds = OFFICIAL_INTEGRATION_CATALOG
    .map(item => item.integrationId)
  return [
    ...preferences.displayOrder.filter(id => catalogIds.includes(id as typeof catalogIds[number])),
    ...catalogIds.filter(id => !preferences.displayOrder.includes(id)),
  ]
}

function cloneTool(tool: OfficialToolDiscoveryItem | undefined): OfficialToolDiscoveryItem | undefined {
  return tool ? { ...tool } : undefined
}

function clonePackage(state: IntegrationPackageState): IntegrationPackageState {
  return { ...state }
}

function cloneCapabilities(
  capabilities: AgentIntegrationRuntimeStatus['capabilities'],
): AgentIntegrationRuntimeStatus['capabilities'] {
  return capabilities.map(item => ({ ...item }))
}

export class IntegrationManagementService {
  private readonly packageState: NonNullable<IntegrationManagementOptions['packageState']>

  constructor(private readonly options: IntegrationManagementOptions) {
    this.packageState = options.packageState ?? bundledPackageState
  }

  preferences(): IntegrationPreferences {
    return this.options.preferences.snapshot()
  }

  updatePreferences(
    request: Parameters<IntegrationPreferenceService['update']>[0],
  ): Promise<IntegrationPreferences> {
    return this.options.preferences.update(request)
  }

  async setEnabled(integrationId: string, enabled: boolean): Promise<IntegrationEnabledState> {
    const normalized = integrationId.trim().toLowerCase()
    if (!officialIntegrationCatalogEntry(normalized)) {
      throw new Error(`Unknown official Agent Integration: ${integrationId}`)
    }

    const before = this.options.capturePolicy.getSourceConfiguration()
    const configured = new Set(before.configuredEnabledSources)
    if (enabled) configured.add(normalized)
    else configured.delete(normalized)

    if (configured.has(normalized) === before.configuredEnabledSources.includes(normalized)) {
      return enabledState(normalized, before)
    }

    const after = await this.options.capturePolicy.setEnabledSources([...configured])
    return enabledState(normalized, after)
  }

  async query(): Promise<IntegrationManagementSnapshot> {
    const [preferences, discovery, configuration] = [
      this.options.preferences.snapshot(),
      this.options.discovery.snapshot(),
      this.options.capturePolicy.getSourceConfiguration(),
    ]
    const discoveryById = new Map(discovery.items.map(item => [item.integrationId, item]))
    const order = orderedCatalogIds(preferences)
    const orderById = new Map(order.map((id, index) => [id, index]))

    const items = await Promise.all(OFFICIAL_INTEGRATION_CATALOG.map(async entry => {
      const [runtimeStatus, packageState] = await Promise.all([
        this.options.integrationStatus(entry.productId),
        this.packageState(entry.integrationId),
      ])
      const tool = discoveryById.get(entry.integrationId)
      const isNew = preferences.onboarding.completed
        && (tool?.presence === 'present' || tool?.presence === 'data-only')
        && !preferences.acknowledgedIntegrationIds.includes(entry.integrationId)
      return {
        integrationId: entry.integrationId,
        productId: entry.productId,
        displayName: entry.displayName,
        ...(tool ? { tool: cloneTool(tool) } : {}),
        package: clonePackage(packageState),
        enabled: enabledState(entry.integrationId, configuration),
        availability: runtimeStatus?.availability ?? 'unavailable',
        capabilities: cloneCapabilities(runtimeStatus?.capabilities ?? []),
        isNew,
        displayOrder: orderById.get(entry.integrationId) ?? Number.MAX_SAFE_INTEGER,
      } satisfies IntegrationManagementItem
    }))

    items.sort((left, right) =>
      left.displayOrder - right.displayOrder
      || left.integrationId.localeCompare(right.integrationId)
    )

    return {
      items,
      discovery: {
        status: discovery.status,
        ...(discovery.startedAt ? { startedAt: discovery.startedAt } : {}),
        ...(discovery.completedAt ? { completedAt: discovery.completedAt } : {}),
        generatedAt: discovery.generatedAt,
      },
      preferences,
      generatedAt: new Date().toISOString(),
    }
  }
}

export const integrationManagementInternals = {
  bundledPackageState,
  enabledState,
  orderedCatalogIds,
}
