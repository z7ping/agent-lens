import type { IntegrationAuthorizationCapabilityDto, IntegrationAuthorizationResponseDto, IntegrationEnabledUpdateResponseDto, IntegrationManagementResponseDto, IntegrationPackageOperationResponseDto, IntegrationPreferenceUpdateRequestDto, IntegrationPreferencesResponseDto, IntegrationToolDiscoveryResponseDto } from '@agent-lens/protocol'
import { translateProduct } from '../i18n/runtime'
import { AgentLensModelBase } from './model-base'
import { INTEGRATION_DISCOVERY_POLL_MS, INTEGRATION_DISCOVERY_MAX_POLLS, discoveryFromManagement } from './model-base'
import type { ClientSnapshot } from './model-base'

function applyManagementPreferences(
  management: IntegrationManagementResponseDto,
  preferences: IntegrationManagementResponseDto['preferences'],
): IntegrationManagementResponseDto {
  const index = new Map(preferences.displayOrder.map((id, position) => [id, position]))
  const acknowledged = new Set(preferences.acknowledgedIntegrationIds)
  const items = management.items
    .map(item => ({
      ...item,
      isNew: preferences.onboarding.completed
        && (item.tool?.presence === 'present' || item.tool?.presence === 'data-only')
        && !acknowledged.has(item.integrationId),
      displayOrder: index.get(item.integrationId) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) =>
      left.displayOrder - right.displayOrder
      || left.integrationId.localeCompare(right.integrationId)
    )
  return { ...management, preferences, items }
}

export abstract class AgentLensIntegrationModel extends AgentLensModelBase {
  abstract refreshReview(options?: { preserveDetail?: boolean }): Promise<void>
  abstract refreshUsage(): Promise<void>
  setIntegrationDiscoveryActive(active: boolean): void {
    this.integrationDiscoveryActive = active
    if (!active) {
      if (this.integrationDiscoveryTimer) clearTimeout(this.integrationDiscoveryTimer)
      this.integrationDiscoveryTimer = null
      return
    }
    const status = this.snapshot.integrationDiscovery?.status
    if (status === 'idle' || status === 'scanning') this.scheduleIntegrationDiscoveryRefresh()
  }

  protected scheduleIntegrationDiscoveryRefresh(): void {
    if (
      !this.integrationDiscoveryActive
      || (typeof document !== 'undefined' && document.hidden)
      || this.integrationDiscoveryTimer
      || this.integrationDiscoveryPolls >= INTEGRATION_DISCOVERY_MAX_POLLS
    ) return
    this.integrationDiscoveryTimer = setTimeout(() => {
      this.integrationDiscoveryTimer = null
      this.integrationDiscoveryPolls += 1
      void this.refreshIntegrationDiscovery()
    }, INTEGRATION_DISCOVERY_POLL_MS)
  }

  protected async refreshIntegrationDiscovery(): Promise<void> {
    try {
      const result = await this.api.integrationDiscovery()
      this.patch({
        integrationDiscovery: result,
        integrationDiscoveryLoading: false,
        integrationDiscoveryError: '',
      })
      if (result.status === 'idle' || result.status === 'scanning') {
        this.scheduleIntegrationDiscoveryRefresh()
      } else {
        this.integrationDiscoveryPolls = 0
        await this.refreshIntegrationManagement().catch(() => undefined)
      }
    } catch (error) {
      this.patch({
        integrationDiscoveryLoading: false,
        integrationDiscoveryError: error instanceof Error ? error.message : String(error),
      })
    }
  }

  refreshIntegrationPreferences(): Promise<void> {
    if (this.integrationPreferencesInFlight) return this.integrationPreferencesInFlight
    this.patch({ integrationPreferencesLoading: true, integrationPreferencesError: '' })
    const pending = this.api.integrationPreferences().then(
      result => {
        this.patch({
          integrationPreferences: result,
          integrationPreferencesLoading: false,
          integrationPreferencesError: '',
        })
      },
      error => {
        this.patch({
          integrationPreferencesLoading: false,
          integrationPreferencesError: error instanceof Error ? error.message : String(error),
        })
        throw error
      },
    ).finally(() => {
      if (this.integrationPreferencesInFlight === pending) this.integrationPreferencesInFlight = null
    })
    this.integrationPreferencesInFlight = pending
    return pending
  }

  ensureIntegrationPreferences(): Promise<void> {
    if (this.snapshot.integrationPreferences) return Promise.resolve()
    return this.refreshIntegrationPreferences()
  }

  refreshIntegrationManagement(): Promise<void> {
    if (this.integrationManagementInFlight) return this.integrationManagementInFlight
    this.patch({ integrationManagementLoading: true, integrationManagementError: '' })
    const pending = this.api.integrations().then(
      management => {
        const discovery = discoveryFromManagement(management)
        this.patch({
          integrationManagement: management,
          integrationPreferences: { preferences: management.preferences, meta: management.meta },
          integrationPreferencesLoading: false,
          integrationPreferencesError: '',
          integrationManagementLoading: false,
          integrationManagementError: '',
          integrationDiscovery: discovery,
          integrationDiscoveryLoading: false,
          integrationDiscoveryError: '',
        })
        if (discovery.status === 'idle' || discovery.status === 'scanning') {
          this.scheduleIntegrationDiscoveryRefresh()
        } else if (discovery.status === 'complete') {
          this.integrationDiscoveryPolls = 0
        }
      },
      error => {
        this.patch({
          integrationManagementLoading: false,
          integrationManagementError: error instanceof Error ? error.message : String(error),
        })
        throw error
      },
    ).finally(() => {
      if (this.integrationManagementInFlight === pending) this.integrationManagementInFlight = null
    })
    this.integrationManagementInFlight = pending
    return pending
  }

  async updateIntegrationPreferences(
    input: IntegrationPreferenceUpdateRequestDto,
  ): Promise<IntegrationPreferencesResponseDto> {
    const result = await this.api.updateIntegrationPreferences(input)
    const current = this.snapshot.integrationManagement
    const patch: Partial<ClientSnapshot> = { integrationPreferences: result }
    if (current) {
      patch.integrationManagement = applyManagementPreferences({
        ...current,
        meta: { ...current.meta, generatedAt: result.meta.generatedAt },
      }, result.preferences)
    }
    this.patch(patch)
    return result
  }

  async installIntegration(
    integrationId: string,
  ): Promise<IntegrationPackageOperationResponseDto> {
    const result = await this.api.installIntegration(integrationId)
    await this.refreshIntegrationManagement().catch(() => undefined)
    return result
  }

  async updateIntegration(
    integrationId: string,
  ): Promise<IntegrationPackageOperationResponseDto> {
    const result = await this.api.updateIntegration(integrationId)
    await this.refreshIntegrationManagement().catch(() => undefined)
    return result
  }

  async removeIntegration(
    integrationId: string,
  ): Promise<IntegrationPackageOperationResponseDto> {
    const result = await this.api.removeIntegration(integrationId)
    await this.refreshIntegrationManagement().catch(() => undefined)
    return result
  }

  async acknowledgeIntegration(integrationId: string): Promise<void> {
    const current = this.snapshot.integrationPreferences?.preferences ?? this.snapshot.integrationManagement?.preferences
    if (!current || current.acknowledgedIntegrationIds.includes(integrationId)) return
    await this.updateIntegrationPreferences({
      acknowledgedIntegrationIds: [...current.acknowledgedIntegrationIds, integrationId],
    })
  }

  async setIntegrationEnabled(
    integrationId: string,
    enabled: boolean,
  ): Promise<IntegrationEnabledUpdateResponseDto> {
    const result = await this.api.setIntegrationEnabled(integrationId, enabled)
    const current = this.snapshot.integrationManagement
    if (current) {
      this.patch({
        integrationManagement: {
          ...current,
          items: current.items.map(item => item.integrationId === integrationId
            ? { ...item, enabled: result.enabled }
            : item),
          meta: { ...current.meta, generatedAt: result.meta.generatedAt },
        },
      })
    }
    return result
  }

  rescanIntegrationDiscovery(integrationId?: string): Promise<IntegrationToolDiscoveryResponseDto> {
    if (this.integrationDiscoveryInFlight) return this.integrationDiscoveryInFlight
    this.patch({ integrationDiscoveryRescanning: true, integrationDiscoveryError: '' })
    const pending = this.api.rescanIntegrationDiscovery(integrationId).then(
      async result => {
        if (this.integrationDiscoveryTimer) {
          clearTimeout(this.integrationDiscoveryTimer)
          this.integrationDiscoveryTimer = null
        }
        this.integrationDiscoveryPolls = 0
        this.patch({
          integrationDiscovery: result,
          integrationDiscoveryLoading: false,
          integrationDiscoveryRescanning: false,
          integrationDiscoveryError: '',
        })
        await this.refreshIntegrationManagement().catch(() => undefined)
        return result
      },
      error => {
        this.patch({
          integrationDiscoveryRescanning: false,
          integrationDiscoveryError: error instanceof Error ? error.message : String(error),
        })
        throw error
      },
    ).finally(() => {
      if (this.integrationDiscoveryInFlight === pending) this.integrationDiscoveryInFlight = null
    })
    this.integrationDiscoveryInFlight = pending
    return pending
  }

  async rescanAgentEnvironment({
    targetId,
    sourceId,
    integrationId,
  }: {
    targetId: string
    sourceId?: string
    integrationId?: string
  }): Promise<void> {
    this.patch({
      agentEnvironmentRescanTargetId: targetId,
      agentsRescanResult: null,
      agentsRescanError: '',
      integrationDiscoveryError: '',
    })
    const tasks: Promise<unknown>[] = []
    if (integrationId) tasks.push(this.rescanIntegrationDiscovery(integrationId))
    if (sourceId) tasks.push(this.rescanAgents(sourceId))
    if (!tasks.length) return

    const results = await Promise.allSettled(tasks)
    if (results.every(result => result.status === 'rejected')) {
      const failure = results[0]
      throw failure?.status === 'rejected' ? failure.reason : new Error('Agent environment rescan failed')
    }
  }

  async setSourceEnabled(sourceId: string, enabled: boolean): Promise<void> {
    const current = this.snapshot.capturePolicy
    if (!current) throw new Error(translateProduct('errors:capturePolicyNotLoaded'))
    const next = new Set(current.settings.configuredEnabledSources)
    if (enabled) next.add(sourceId)
    else next.delete(sourceId)
    const capturePolicy = await this.api.updateCaptureSources([...next])
    this.patch({ capturePolicy })
  }

  async authorizeIntegration(
    productId: string,
    capabilities: readonly IntegrationAuthorizationCapabilityDto[],
  ): Promise<IntegrationAuthorizationResponseDto> {
    const result = await this.api.authorizeIntegration(productId, capabilities)
    await this.refreshAgents()
    return result
  }

  async refreshFacetsAndAgents(): Promise<void> {
    await Promise.all([this.refreshFacets(), this.refreshAgents()])
  }

  ensureReview(): Promise<void> {
    if (this.snapshot.review.response) return Promise.resolve()
    return this.reviewInFlight ?? this.refreshReview()
  }

  ensureUsage(): Promise<void> {
    return this.snapshot.usage.response ? Promise.resolve() : this.refreshUsage()
  }

  ensureIntegrationManagement(): Promise<void> {
    if (this.snapshot.integrationManagement) {
      const status = this.snapshot.integrationManagement.discovery.status
      if (status === 'idle' || status === 'scanning') this.scheduleIntegrationDiscoveryRefresh()
      return Promise.resolve()
    }
    return this.refreshIntegrationManagement()
  }

  ensureAgents(): Promise<void> {
    if (this.snapshot.agentSummaries) return Promise.resolve()
    if (this.agentsInFlight) return this.agentsInFlight
    const pending = this.refreshAgents().finally(() => {
      if (this.agentsInFlight === pending) this.agentsInFlight = null
    })
    this.agentsInFlight = pending
    return pending
  }

}
