import type { IntegrationPackageState } from '@agent-lens/integration-packages'
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
  packageState: IntegrationPackageState | null
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
}

export interface IntegrationManagementOptions {
  discovery: {
    snapshot(): OfficialToolDiscoverySnapshot
  }
  preferences: IntegrationPreferenceService
  capturePolicy: CapturePolicyService
  packageState?(integrationId: string): IntegrationPackageState | null
  integrationStatus(
    productId: string,
  ): AgentIntegrationRuntimeStatus | null | Promise<AgentIntegrationRuntimeStatus | null>
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
  const catalogIds = OFFICIAL_INTEGRATION_CATALOG.map(item => item.integrationId)
  return [
    ...preferences.displayOrder.filter(id => catalogIds.includes(id as typeof catalogIds[number])),
    ...catalogIds.filter(id => !preferences.displayOrder.includes(id)),
  ]
}

function cloneTool(tool: OfficialToolDiscoveryItem | undefined): OfficialToolDiscoveryItem | undefined {
  return tool ? { ...tool } : undefined
}

function cloneCapabilities(
  capabilities: AgentIntegrationRuntimeStatus['capabilities'],
): AgentIntegrationRuntimeStatus['capabilities'] {
  return capabilities.map(item => ({ ...item }))
}

export class IntegrationManagementService {
  constructor(private readonly options: IntegrationManagementOptions) {}

  preferences(): IntegrationPreferences {
    return this.options.preferences.snapshot()
  }

  updatePreferences(
    request: Parameters<IntegrationPreferenceService['update']>[0],
  ): Promise<IntegrationPreferences> {
    return this.options.preferences.update(request)
  }

  enabled(integrationId: string): IntegrationEnabledState | null {
    const normalized = integrationId.trim().toLowerCase()
    if (!officialIntegrationCatalogEntry(normalized)) return null
    return enabledState(normalized, this.options.capturePolicy.getSourceConfiguration())
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

    const alreadyConfigured = before.configuredEnabledSources.includes(normalized)
    if (enabled === alreadyConfigured) return enabledState(normalized, before)

    const after = await this.options.capturePolicy.setEnabledSources([...configured])
    return enabledState(normalized, after)
  }

  async query(): Promise<IntegrationManagementSnapshot> {
    const preferences = this.options.preferences.snapshot()
    const discovery = this.options.discovery.snapshot()
    const configuration = this.options.capturePolicy.getSourceConfiguration()
    const discoveryById = new Map(discovery.items.map(item => [item.integrationId, item]))
    const order = orderedCatalogIds(preferences)
    const orderById = new Map(order.map((id, index) => [id, index]))

    const items = await Promise.all(OFFICIAL_INTEGRATION_CATALOG.map(async entry => {
      const runtimeStatusResult = await Promise.resolve(
        this.options.integrationStatus(entry.productId),
      ).then(
        value => ({ value, failed: false as const }),
        () => ({ value: null, failed: true as const }),
      )
      const runtimeStatus = runtimeStatusResult.value
      const tool = discoveryById.get(entry.integrationId)
      const isNew = preferences.onboarding.completed
        && (tool?.presence === 'present' || tool?.presence === 'data-only')
        && !preferences.acknowledgedIntegrationIds.includes(entry.integrationId)

      return {
        integrationId: entry.integrationId,
        productId: entry.productId,
        displayName: entry.displayName,
        ...(tool ? { tool: cloneTool(tool) } : {}),
        packageState: this.options.packageState?.(entry.integrationId) ?? null,
        enabled: enabledState(entry.integrationId, configuration),
        availability: runtimeStatusResult.failed
          ? 'error'
          : runtimeStatus?.availability ?? 'unavailable',
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
    }
  }
}

export const integrationManagementInternals = {
  enabledState,
  orderedCatalogIds,
}
