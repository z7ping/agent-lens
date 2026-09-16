import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type {
  IntegrationManagementItemDto,
  IntegrationToolDiscoveryItemDto,
} from '@agent-lens/protocol'
import { sourceDot } from '../../components/AgentScope'
import { Button, StatusBadge } from '../../components/ui'
import {
  integrationManagementLifecycleState,
  integrationToolPresenceLabel,
  integrationToolPresencePath,
} from './integration-lifecycle'

const integrationCapabilityLabelKey: Record<string, string> = {
  source: 'integrationCapability.source',
  hook: 'integrationCapability.hook',
  runtime: 'integrationCapability.runtime',
  live: 'integrationCapability.live',
  assets: 'integrationCapability.assets',
}

const integrationAvailabilityLabelKey: Record<string, string> = {
  available: 'availability.available',
  partial: 'availability.partial',
  unavailable: 'availability.unavailable',
  error: 'availability.error',
}

const integrationReasonKey: Record<string, string> = {
  'authorization-required': 'integration.reason.authorizationRequired',
  'authorization-restart-required': 'integration.reason.authorizationRestartRequired',
  'component-start-failed': 'integration.reason.componentStartFailed',
  'dependency-start-failed': 'integration.reason.dependencyStartFailed',
  'live-adapter-missing': 'integration.reason.liveAdapterMissing',
  'live-availability-failed': 'integration.reason.liveAvailabilityFailed',
}

function translatedLabel(
  map: Record<string, string>,
  value: string,
  t: TFunction,
): string {
  const key = map[value]
  return key ? t(key) : value
}

function integrationAvailabilityTone(
  availability: string,
): 'success' | 'warning' | 'danger' | 'neutral' {
  if (availability === 'available') return 'success'
  if (availability === 'partial' || availability === 'unavailable') return 'warning'
  if (availability === 'error') return 'danger'
  return 'neutral'
}

function integrationLifecycleTone(
  className: string,
): 'success' | 'warning' | 'danger' | 'neutral' | 'accent' {
  if (className.includes('error')) return 'danger'
  if (className.includes('enabled')) return 'success'
  if (className.includes('history')) return 'warning'
  if (className.includes('not-added')) return 'accent'
  return 'neutral'
}

function shortPath(path: string, max = 58): string {
  if (path.length <= max) return path
  const left = Math.max(16, Math.floor(max * 0.38))
  const right = Math.max(24, max - left - 1)
  return `${path.slice(0, left)}…${path.slice(-right)}`
}

export function IntegrationObservationPanel({
  management,
  discovery,
  discoveryScanning,
  discoveryError,
  onManage,
}: {
  management: IntegrationManagementItemDto
  discovery: IntegrationToolDiscoveryItemDto | undefined
  discoveryScanning: boolean
  discoveryError: string
  onManage(integrationId: string): void
}) {
  const { t } = useTranslation('agents')
  const status = integrationManagementLifecycleState(management, t)

  return <section className="integration-observation">
    <div className="integration-observation-main">
      <span className="integration-observation-fact">
        <small>{t('observation.integrationStatus')}</small>
        <StatusBadge tone={integrationLifecycleTone(status.className)} title={status.title}>{status.label}</StatusBadge>
      </span>
      <span className="integration-observation-fact">
        <small>{t('toolPresence.label')}</small>
        <b title={discoveryError || discovery?.reason}>
          {integrationToolPresenceLabel(discovery, discoveryScanning, discoveryError, t)}
        </b>
      </span>
      <span className="integration-observation-fact">
        <small>{t('integration.currentAvailability')}</small>
        <StatusBadge tone={integrationAvailabilityTone(management.availability)} dot>
          {translatedLabel(integrationAvailabilityLabelKey, management.availability, t)}
        </StatusBadge>
      </span>
      <span className="integration-observation-capabilities">
        {management.capabilities.map(item => <StatusBadge
          key={item.capability}
          tone={integrationAvailabilityTone(item.availability)}
          title={item.reasonCode ? translatedLabel(integrationReasonKey, item.reasonCode, t) : item.reason}
        >
          {translatedLabel(integrationCapabilityLabelKey, item.capability, t)}
          {item.authorization === 'required' ? ` · ${t('integration.pendingAuthorization')}` : ''}
        </StatusBadge>)}
        {!management.capabilities.length && <span className="integration-observation-muted">{t('managementPage.capabilitiesPending')}</span>}
      </span>
    </div>
    <Button size="small" onClick={() => onManage(management.integrationId)}>
      {t('observation.manageIntegration')}
    </Button>
  </section>
}

export function IntegrationOnlyObservationCard({
  management,
  discovery,
  discoveryScanning,
  discoveryError,
  onManage,
}: {
  management: IntegrationManagementItemDto
  discovery: IntegrationToolDiscoveryItemDto | undefined
  discoveryScanning: boolean
  discoveryError: string
  onManage(integrationId: string): void
}) {
  const { t } = useTranslation('agents')
  const status = integrationManagementLifecycleState(management, t)
  const packageState = management.packageState
  const presencePath = integrationToolPresencePath(discovery)

  return <article className="agent-card agent-integration-placeholder" data-source={management.integrationId}>
    <header className="agent-card-head">
      <div className="agent-identity">
        <span className={`source-dot large ${sourceDot(management.integrationId)}`}/>
        <div><h2>{management.displayName}</h2></div>
      </div>
      <span className={`agent-status ${status.className}`} title={status.title}>{status.label}</span>
    </header>

    <div className="agent-installation">
      <span className="agent-tool-presence">
        <small>{t('toolPresence.label')}</small>
        <b
          title={discoveryError || discovery?.reason || undefined}
          data-presence={discoveryError ? 'error' : discovery?.presence ?? (discoveryScanning ? 'scanning' : 'absent')}
        >{integrationToolPresenceLabel(discovery, discoveryScanning, discoveryError, t)}</b>
      </span>
      <span>
        <small>{t('installation.integrationVersion')}</small>
        <b>{packageState?.installedVersion ?? packageState?.availableVersion ?? t('installation.notAdded')}</b>
      </span>
      {presencePath && <span className="agent-config">
        <small>{t('toolPresence.location')}</small>
        <code title={presencePath}>{shortPath(presencePath, 52)}</code>
      </span>}
    </div>

    <section className="integration-placeholder-body">
      <div><b>{t('observation.noOverviewTitle')}</b></div>
      <Button size="small" variant="primary" onClick={() => onManage(management.integrationId)}>
        {t('observation.manageIntegration')}
      </Button>
    </section>
  </article>
}
