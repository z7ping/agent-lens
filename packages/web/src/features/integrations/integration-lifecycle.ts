import type { TFunction } from 'i18next'
import type {
  AgentOverviewDto,
  IntegrationManagementItemDto,
  IntegrationToolDiscoveryItemDto,
} from '@agent-lens/protocol'

export interface IntegrationLifecyclePresentation {
  label: string
  title: string
  className: string
}

export function integrationLifecycleState(
  agent: Pick<AgentOverviewDto, 'supported' | 'enabled' | 'detected'> | undefined,
  management: IntegrationManagementItemDto | undefined,
  discovery: IntegrationToolDiscoveryItemDto | undefined,
  discoveryScanning: boolean,
  t: TFunction,
): IntegrationLifecyclePresentation {
  if (management) {
    const packageState = management.packageState
    if (!packageState) {
      return {
        label: t('status.managementUnavailable'),
        title: t('status.managementUnavailableTitle'),
        className: 'is-error',
      }
    }
    if (!packageState.installed) {
      if (discovery?.presence === 'error') {
        return {
          label: t('status.scanFailed'),
          title: discovery.reason || t('status.scanFailedTitle'),
          className: 'is-error',
        }
      }
      if (discovery?.presence === 'present' || discovery?.presence === 'data-only') {
        return {
          label: t('status.notAdded'),
          title: t('status.notAddedTitle'),
          className: 'is-not-added',
        }
      }
      if (discoveryScanning) {
        return {
          label: t('status.scanning'),
          title: t('status.scanningTitle'),
          className: 'is-scanning',
        }
      }
      return {
        label: t('status.notFound'),
        title: t('status.notFoundTitle'),
        className: 'is-missing',
      }
    }

    if (!agent?.detected && discoveryScanning) {
      return {
        label: t('status.scanning'),
        title: t('status.scanningTitle'),
        className: 'is-scanning',
      }
    }
    if (!agent?.detected && discovery?.presence !== 'present') {
      return {
        label: t('status.notDetected'),
        title: t('status.notDetectedTitle'),
        className: 'is-missing',
      }
    }
    if (!management.enabled.configured) {
      if (management.enabled.restartRequired || packageState.restartRequired) {
        return {
          label: t('status.pendingRestart'),
          title: t('status.pendingRestartTitle'),
          className: 'is-history',
        }
      }
      return {
        label: t('status.disabled'),
        title: t('status.disabledTitle'),
        className: 'is-disabled',
      }
    }
    if (management.enabled.restartRequired || packageState.restartRequired) {
      return {
        label: t('status.pendingRestart'),
        title: t('status.pendingRestartTitle'),
        className: 'is-history',
      }
    }
    if (management.availability === 'error') {
      return {
        label: t('status.abnormal'),
        title: t('status.abnormalTitle'),
        className: 'is-error',
      }
    }
    if (management.availability === 'unavailable') {
      return {
        label: t('status.unavailable'),
        title: t('status.unavailableTitle'),
        className: 'is-history',
      }
    }
    return {
      label: t('status.enabled'),
      title: t('status.enabledTitle'),
      className: 'is-enabled is-detected',
    }
  }

  if (!agent) {
    if (discoveryScanning) {
      return {
        label: t('status.scanning'),
        title: t('status.scanningTitle'),
        className: 'is-scanning',
      }
    }
    return {
      label: t('status.notDetected'),
      title: t('status.notDetectedTitle'),
      className: 'is-missing',
    }
  }
  if (!agent.supported) {
    return {
      label: t('status.unsupported'),
      title: t('status.unsupportedTitle'),
      className: 'is-unsupported',
    }
  }
  if (agent.detected) {
    if (!agent.enabled) {
      return {
        label: t('status.disabled'),
        title: t('status.disabledTitle'),
        className: 'is-disabled',
      }
    }
    return {
      label: t('status.enabled'),
      title: t('status.enabledTitle'),
      className: 'is-enabled is-detected',
    }
  }
  if (discovery?.presence === 'error') {
    return {
      label: t('status.scanFailed'),
      title: discovery.reason || t('status.scanFailedTitle'),
      className: 'is-error',
    }
  }
  if (discovery?.presence === 'data-only') {
    return {
      label: t('status.historyData'),
      title: t('status.historyDataTitle'),
      className: 'is-history',
    }
  }
  if (discoveryScanning) {
    return {
      label: t('status.scanning'),
      title: t('status.scanningTitle'),
      className: 'is-scanning',
    }
  }
  return {
    label: t('status.notDetected'),
    title: t('status.notDetectedTitle'),
    className: 'is-missing',
  }
}

export function integrationCanInstall(
  discovery: IntegrationToolDiscoveryItemDto | undefined,
): boolean {
  return discovery?.presence === 'present' || discovery?.presence === 'data-only'
}

export function integrationToolPresenceLabel(
  discovery: IntegrationToolDiscoveryItemDto | undefined,
  discoveryScanning: boolean,
  discoveryError: string,
  t: TFunction,
): string {
  if (discoveryError) return t('toolPresence.error')
  if (discovery?.presence === 'present') return t('toolPresence.present')
  if (discovery?.presence === 'data-only') return t('toolPresence.dataOnly')
  if (discovery?.presence === 'error') return t('toolPresence.error')
  if (discoveryScanning) return t('toolPresence.scanning')
  return t('toolPresence.absent')
}

export function integrationToolPresencePath(
  discovery: IntegrationToolDiscoveryItemDto | undefined,
): string | undefined {
  return discovery?.executable ?? discovery?.configRoot ?? discovery?.dataRoot
}
