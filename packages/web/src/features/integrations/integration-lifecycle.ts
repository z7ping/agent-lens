import type { TFunction } from 'i18next'
import * as semver from 'semver'
import type {
  AgentOverviewDto,
  IntegrationManagementItemDto,
  IntegrationPackageStateDto,
  IntegrationToolDiscoveryItemDto,
} from '@agent-lens/protocol'

export interface IntegrationLifecyclePresentation {
  label: string
  title: string
  className: string
}

export function integrationPackageReady(
  state: IntegrationPackageStateDto | null | undefined,
): boolean {
  return state?.installed === true
    && state.integrity === 'verified'
    && state.compatibility === 'compatible'
}

/** Bundles older than an installed Integration must never be offered as upgrades. */
export function integrationPackageUpdateAvailable(
  state: IntegrationPackageStateDto | null | undefined,
): boolean {
  if (!integrationPackageReady(state) || state?.restartRequired) return false
  const installed = state.installedVersion
  const bundled = state.availableVersion
  return Boolean(installed && bundled && semver.valid(installed) && semver.valid(bundled) && semver.gt(bundled, installed))
}

export interface AgentUpgradeMethod {
  value: string
  labelKey: 'npmGlobal' | 'officialUnix' | 'officialWindows' | 'homebrew'
  installCommand: string
  updateCommand: string
  docsUrl: string
}

/** Documentation-based examples, not an inferred package manager or automatic execution. */
const OFFICIAL_AGENT_UPGRADE_METHODS: Readonly<Record<string, readonly AgentUpgradeMethod[]>> = {
  pi: [
    {
      value: 'npm', labelKey: 'npmGlobal',
      installCommand: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
      updateCommand: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest',
      docsUrl: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent',
    },
    {
      value: 'installer-unix', labelKey: 'officialUnix',
      installCommand: 'curl -fsSL https://pi.dev/install.sh | sh',
      updateCommand: 'pi update --self',
      docsUrl: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent',
    },
    {
      value: 'installer-windows', labelKey: 'officialWindows',
      installCommand: 'powershell -c "irm https://pi.dev/install.ps1 | iex"',
      updateCommand: 'pi update --self',
      docsUrl: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent',
    },
  ],
  codex: [
    {
      value: 'npm', labelKey: 'npmGlobal',
      installCommand: 'npm install -g @openai/codex',
      updateCommand: 'npm install -g @openai/codex@latest',
      docsUrl: 'https://github.com/openai/codex',
    },
    {
      value: 'homebrew', labelKey: 'homebrew',
      installCommand: 'brew install --cask codex',
      updateCommand: 'brew upgrade --cask codex',
      docsUrl: 'https://github.com/openai/codex',
    },
  ],
  'claude-code': [
    {
      value: 'installer-unix', labelKey: 'officialUnix',
      installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
      updateCommand: 'claude update',
      docsUrl: 'https://code.claude.com/docs/en/setup',
    },
    {
      value: 'installer-windows', labelKey: 'officialWindows',
      installCommand: 'irm https://claude.ai/install.ps1 | iex',
      updateCommand: 'claude update',
      docsUrl: 'https://code.claude.com/docs/en/setup',
    },
  ],
  hermes: [
    {
      value: 'installer-unix', labelKey: 'officialUnix',
      installCommand: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
      updateCommand: 'hermes update',
      docsUrl: 'https://hermes-agent.nousresearch.com/docs/getting-started/updating',
    },
    {
      value: 'installer-windows', labelKey: 'officialWindows',
      installCommand: 'iex (irm https://hermes-agent.nousresearch.com/install.ps1)',
      updateCommand: 'hermes update',
      docsUrl: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation',
    },
  ],
  opencode: [
    {
      value: 'npm', labelKey: 'npmGlobal',
      installCommand: 'npm install -g opencode-ai',
      updateCommand: 'npm install -g opencode-ai@latest',
      docsUrl: 'https://opencode.ai/docs',
    },
    {
      value: 'installer-unix', labelKey: 'officialUnix',
      installCommand: 'curl -fsSL https://opencode.ai/install | bash',
      updateCommand: 'opencode upgrade',
      docsUrl: 'https://opencode.ai/docs/cli/',
    },
  ],
}

export function agentUpgradeMethods(productId: string): readonly AgentUpgradeMethod[] {
  return OFFICIAL_AGENT_UPGRADE_METHODS[productId] ?? []
}

export function agentObservationState(
  agent: Pick<AgentOverviewDto, 'supported' | 'detected'> | undefined,
  discovery: IntegrationToolDiscoveryItemDto | undefined,
  discoveryScanning: boolean,
  t: TFunction,
  discoveryError = '',
): IntegrationLifecyclePresentation {
  if (!agent?.supported && agent) {
    return {
      label: t('status.unsupported'),
      title: t('status.unsupportedTitle'),
      className: 'is-unsupported',
    }
  }
  if (discoveryError || discovery?.presence === 'error') {
    return {
      label: t('status.scanFailed'),
      title: discoveryError || discovery?.reason || t('status.scanFailedTitle'),
      className: 'is-error',
    }
  }
  if (agent?.detected || discovery?.presence === 'present') {
    return {
      label: t('status.discovered'),
      title: t('status.discoveredTitle'),
      className: 'is-discovered',
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

export function integrationManagementLifecycleState(
  management: IntegrationManagementItemDto,
  t: TFunction,
): IntegrationLifecyclePresentation {
  const packageState = management.packageState
  if (!packageState) {
    return {
      label: t('status.managementUnavailable'),
      title: t('status.managementUnavailableTitle'),
      className: 'is-error',
    }
  }
  if (!packageState.installed) {
    return {
      label: t('status.notAdded'),
      title: t('managementPage.notAddedTitle'),
      className: 'is-not-added',
    }
  }
  if (!integrationPackageReady(packageState)) {
    return {
      label: t('status.abnormal'),
      title: packageState.reason || t('status.abnormalTitle'),
      className: 'is-error',
    }
  }
  if (management.enabled.restartRequired || packageState.restartRequired) {
    return {
      label: t('status.pendingRestart'),
      title: t('status.pendingRestartTitle'),
      className: 'is-history',
    }
  }
  if (!management.enabled.configured) {
    return {
      label: t('status.disabled'),
      title: t('managementPage.disabledTitle'),
      className: 'is-disabled',
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
    title: t('managementPage.enabledTitle'),
    className: 'is-enabled',
  }
}

export function integrationLifecycleState(
  agent: Pick<AgentOverviewDto, 'supported' | 'enabled' | 'detected'> | undefined,
  management: IntegrationManagementItemDto | undefined,
  discovery: IntegrationToolDiscoveryItemDto | undefined,
  discoveryScanning: boolean,
  t: TFunction,
  discoveryError = '',
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
      if (discoveryError || discovery?.presence === 'error') {
        return {
          label: t('status.scanFailed'),
          title: discoveryError || discovery?.reason || t('status.scanFailedTitle'),
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

    if (!integrationPackageReady(packageState)) {
      return {
        label: t('status.abnormal'),
        title: packageState.reason || t('status.abnormalTitle'),
        className: 'is-error',
      }
    }

    if (!agent?.detected && (discoveryError || discovery?.presence === 'error')) {
      return {
        label: t('status.scanFailed'),
        title: discoveryError || discovery?.reason || t('status.scanFailedTitle'),
        className: 'is-error',
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
    if (discoveryError || discovery?.presence === 'error') {
      return {
        label: t('status.scanFailed'),
        title: discoveryError || discovery?.reason || t('status.scanFailedTitle'),
        className: 'is-error',
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
  if (discoveryError || discovery?.presence === 'error') {
    return {
      label: t('status.scanFailed'),
      title: discoveryError || discovery?.reason || t('status.scanFailedTitle'),
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
