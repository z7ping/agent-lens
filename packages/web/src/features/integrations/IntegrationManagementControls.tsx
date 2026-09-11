import { useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type {
  AgentOverviewDto,
  CapturePolicyResponseDto,
  IntegrationAuthorizationCapabilityDto,
  IntegrationManagementItemDto,
  IntegrationPackageOperationResponseDto,
  IntegrationToolDiscoveryItemDto,
} from '@agent-lens/protocol'
import { agentLabel, sourceDot } from '../../components/AgentScope'
import { Button, Dialog, StatusBadge, UiIcon } from '../../components/ui'
import {
  integrationCanInstall,
  integrationLifecycleState,
  integrationPackageReady,
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

function shortPath(path: string, max = 58): string {
  if (path.length <= max) return path
  const left = Math.max(16, Math.floor(max * 0.38))
  const right = Math.max(24, max - left - 1)
  return `${path.slice(0, left)}…${path.slice(-right)}`
}

function DisclosureChevron() {
  return <UiIcon className="disclosure-chevron" name="chevron-right" size={14}/>
}

export function IntegrationControl({
  agent,
  management,
  policy,
  onChange,
  onInstall,
  onAuthorize,
}: {
  agent: AgentOverviewDto
  management: IntegrationManagementItemDto | undefined
  policy: CapturePolicyResponseDto | null
  onChange(sourceId: string, enabled: boolean): Promise<void>
  onInstall(integrationId: string): Promise<IntegrationPackageOperationResponseDto>
  onAuthorize(
    productId: string,
    capabilities: readonly IntegrationAuthorizationCapabilityDto[],
  ): Promise<unknown>
}) {
  const { t } = useTranslation('agents')
  const [saving, setSaving] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState('')
  const [authorizationOpen, setAuthorizationOpen] = useState(false)
  const [authorizationSaved, setAuthorizationSaved] = useState(false)
  const settings = policy?.settings
  const configured = management?.enabled.configured
    ?? settings?.configuredEnabledSources.includes(agent.sourceId)
    ?? agent.enabled
  const effective = management?.enabled.effective
    ?? settings?.effectiveEnabledSources.includes(agent.sourceId)
    ?? agent.enabled
  const pending = configured !== effective
  const editable = management?.enabled.editable ?? settings?.editable ?? false
  const managedBy = management?.enabled.managedBy ?? settings?.managedBy
  const integrationAvailability = management?.availability ?? agent.integration?.availability
  const integrationCapabilities = management?.capabilities ?? agent.integration?.capabilities ?? []
  const pendingAuthorization = integrationCapabilities
    .filter(item => item.authorization === 'required')
    .map(item => item.capability)
    .filter((capability): capability is IntegrationAuthorizationCapabilityDto =>
      capability === 'hook' || capability === 'runtime' || capability === 'live'
    )

  const persistEnabled = async (enabled: boolean) => {
    setSaving(true)
    setError('')
    try {
      await onChange(management?.integrationId ?? agent.sourceId, enabled)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const install = async () => {
    if (!management || installing) return
    setInstalling(true)
    setError('')
    try {
      const result = await onInstall(management.integrationId)
      if (
        result.operation.status !== 'completed'
        || !integrationPackageReady(result.state)
      ) {
        throw new Error(result.operation.message || result.state.reason || t('integration.installFailed'))
      }
      await onChange(management.integrationId, true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setInstalling(false)
    }
  }

  const toggle = () => {
    if (!editable || saving) return
    void persistEnabled(!configured)
  }

  const authorize = async () => {
    if (!pendingAuthorization.length || saving) return
    setSaving(true)
    setError('')
    try {
      await onAuthorize(agent.productId, pendingAuthorization)
      setAuthorizationSaved(true)
      setAuthorizationOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  if (management && !management.packageState) {
    return <section className="source-capture-control">
      <div>
        <h3>{t('integration.title')}</h3>
        <p>{t('integration.packageLifecycleUnavailable')}</p>
      </div>
      <StatusBadge tone="danger">{t('status.managementUnavailable')}</StatusBadge>
    </section>
  }

  if (management?.packageState && !integrationPackageReady(management.packageState)) {
    const repair = management.packageState.installed
    const canInstall = repair || integrationCanInstall(management.tool)
    return <section className="source-capture-control">
      <div>
        <h3>{repair ? t('integration.repairTitle') : t('integration.notAddedTitle')}</h3>
        <p>{repair
          ? t('integration.repairDescription')
          : canInstall
            ? t('integration.notAddedDescription')
            : t('integration.notDetectedDescription')}</p>
        {error && <p className="source-capture-error">{error}</p>}
      </div>
      <Button variant="primary" loading={installing} disabled={!canInstall} onClick={() => void install()}>
        {repair ? t('integration.repair') : t('integration.addToAgentLens')}
      </Button>
    </section>
  }

  return <section className="source-capture-control">
    <div>
      <h3>{t('integration.title')}</h3>
      <p>{pending
        ? configured ? t('integration.pendingEnabled') : t('integration.pendingDisabled')
        : configured
          ? t('integration.enabledDescription')
          : t('integration.disabledDescription')}</p>
      {integrationAvailability && <div className="integration-availability">
        <span className="integration-availability-overall">
          <small>{t('integration.currentAvailability')}</small>
          <StatusBadge tone={integrationAvailabilityTone(integrationAvailability)} dot>
            {translatedLabel(integrationAvailabilityLabelKey, integrationAvailability, t)}
          </StatusBadge>
        </span>
        <span className="integration-capability-badges">
          {integrationCapabilities.map(item => <StatusBadge
            key={item.capability}
            tone={integrationAvailabilityTone(item.availability)}
            title={item.reasonCode ? translatedLabel(integrationReasonKey, item.reasonCode, t) : item.reason}
          >{translatedLabel(integrationCapabilityLabelKey, item.capability, t)} · {item.reasonCode === 'authorization-restart-required'
              ? t('integration.pendingRestart')
              : item.authorization === 'required'
                ? t('integration.pendingAuthorization')
                : translatedLabel(integrationAvailabilityLabelKey, item.availability, t)}</StatusBadge>)}
        </span>
      </div>}
      {configured && pendingAuthorization.length > 0 && !authorizationSaved && <div className="integration-authorization-action">
        <Button size="small" disabled={saving} onClick={() => setAuthorizationOpen(true)}>{t('integration.authorizeControl')}</Button>
        <span>{t('integration.authorizeHint')}</span>
      </div>}
      {authorizationSaved && <p className="source-capture-note">{t('integration.authorizationSaved')}</p>}
      {!editable && managedBy && <p className="source-capture-note">{t('integration.managedReadonly', {
        manager: managedBy === 'environment' ? t('integration.environmentManager') : t('integration.runtimeManager'),
      })}</p>}
      {error && <p className="source-capture-error">{error}</p>}
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={configured}
      className="source-capture-switch"
      data-enabled={configured || undefined}
      disabled={!editable || saving}
      onClick={toggle}
    ><span aria-hidden="true"/><b>{saving ? t('integration.saving') : configured ? t('integration.enabled') : t('integration.disabled')}</b></button>
    <Dialog
      open={authorizationOpen}
      title={t('integration.dialogTitle', { agent: agentLabel(agent.sourceId, agent.displayName) })}
      description={t('integration.dialogDescription')}
      onClose={() => { if (!saving) setAuthorizationOpen(false) }}
      closeDisabled={saving}
      footer={<>
        <Button disabled={saving} onClick={() => setAuthorizationOpen(false)}>{t('integration.cancel')}</Button>
        <Button variant="primary" loading={saving} onClick={() => void authorize()}>{t('integration.confirm')}</Button>
      </>}
    >
      <div className="integration-authorization-list">
        {pendingAuthorization.map(capability => <div key={capability}>
          <b>{translatedLabel(integrationCapabilityLabelKey, capability, t)}</b>
          <span>{capability === 'runtime'
            ? t('integration.runtimePermission')
            : capability === 'live'
              ? t('integration.livePermission')
              : t('integration.hookPermission')}</span>
        </div>)}
      </div>
      <p className="integration-authorization-note">{t('integration.persistedNote')}</p>
    </Dialog>
  </section>
}

export function IntegrationAdvancedActions({
  management,
  label,
  onChange,
  onRemove,
}: {
  management: IntegrationManagementItemDto | undefined
  label: string
  onChange(integrationId: string, enabled: boolean): Promise<void>
  onRemove(integrationId: string): Promise<IntegrationPackageOperationResponseDto>
}) {
  const { t } = useTranslation('agents')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  if (!management?.packageState?.installed) return null

  const remove = async () => {
    if (saving) return
    setSaving(true)
    setMessage('')
    setError('')
    try {
      if (management.enabled.configured) {
        await onChange(management.integrationId, false)
      }
      if (management.enabled.effective) {
        setMessage(t('integration.uninstallRestartRequired'))
        return
      }
      const result = await onRemove(management.integrationId)
      if (result.operation.status !== 'completed' || result.state.installed) {
        throw new Error(result.operation.message || result.state.reason || t('integration.uninstallFailed'))
      }
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return <details className="disclosure-group integration-advanced">
    <summary><DisclosureChevron/><span>{t('integration.advancedTitle')}</span></summary>
    <div className="integration-advanced-body">
      <div>
        <b>{t('integration.uninstallTitle')}</b>
        <span>{t('integration.uninstallDescription')}</span>
        {management.packageState.installedVersion && <small>{t('integration.installedVersion', { version: management.packageState.installedVersion })}</small>}
      </div>
      <Button variant="danger" size="small" onClick={() => { setMessage(''); setError(''); setOpen(true) }}>
        {t('integration.uninstall')}
      </Button>
    </div>
    <Dialog
      open={open}
      title={t('integration.uninstallDialogTitle', { agent: label })}
      description={t('integration.uninstallDialogDescription')}
      onClose={() => { if (!saving) setOpen(false) }}
      closeDisabled={saving}
      footer={<>
        <Button disabled={saving} onClick={() => setOpen(false)}>{t('integration.cancel')}</Button>
        <Button variant="danger" loading={saving} onClick={() => void remove()}>
          {management.enabled.effective ? t('integration.disableBeforeUninstall') : t('integration.confirmUninstall')}
        </Button>
      </>}
    >
      {message && <p className="integration-uninstall-note">{message}</p>}
      {error && <p className="source-capture-error">{error}</p>}
      <p className="integration-authorization-note">{t('integration.uninstallKeepsHistory')}</p>
    </Dialog>
  </details>
}

export function IntegrationOnlyCard({
  management,
  discovery,
  discoveryScanning,
  discoveryError,
  description,
  onChange,
  onInstall,
  onRemove,
}: {
  management: IntegrationManagementItemDto
  discovery: IntegrationToolDiscoveryItemDto | undefined
  discoveryScanning: boolean
  discoveryError: string
  description: string
  onChange(integrationId: string, enabled: boolean): Promise<void>
  onInstall(integrationId: string): Promise<IntegrationPackageOperationResponseDto>
  onRemove(integrationId: string): Promise<IntegrationPackageOperationResponseDto>
}) {
  const { t } = useTranslation('agents')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const status = integrationLifecycleState(undefined, management, discovery, discoveryScanning, t)
  const packageState = management.packageState
  const packageReady = integrationPackageReady(packageState)
  const packageNeedsRepair = packageState?.installed === true && !packageReady
  const presencePath = integrationToolPresencePath(discovery)
  const canInstall = integrationCanInstall(discovery)

  const install = async () => {
    if (!packageState || packageReady || saving) return
    setSaving(true)
    setError('')
    try {
      const result = await onInstall(management.integrationId)
      if (
        result.operation.status !== 'completed'
        || !integrationPackageReady(result.state)
      ) {
        throw new Error(result.operation.message || result.state.reason || t('integration.installFailed'))
      }
      await onChange(management.integrationId, true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const toggle = async () => {
    if (!packageReady || !management.enabled.editable || saving) return
    setSaving(true)
    setError('')
    try {
      await onChange(management.integrationId, !management.enabled.configured)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return <article className="agent-card" data-source={management.integrationId}>
    <header className="agent-card-head">
      <div className="agent-identity">
        <span className={`source-dot large ${sourceDot(management.integrationId)}`}/>
        <div><h2>{management.displayName}</h2><p>{description}</p></div>
      </div>
      <span className={`agent-status ${status.className}`} title={status.title}>{status.label}</span>
    </header>

    <div className="agent-installation">
      <span className="agent-tool-presence"><small>{t('toolPresence.label')}</small><b data-presence={discoveryError ? 'error' : discovery?.presence ?? (discoveryScanning ? 'scanning' : 'absent')}>{integrationToolPresenceLabel(discovery, discoveryScanning, discoveryError, t)}</b></span>
      <span><small>{t('installation.integrationVersion')}</small><b>{packageState?.installedVersion ?? packageState?.availableVersion ?? t('installation.notAdded')}</b></span>
      {presencePath && <span className="agent-config"><small>{t('toolPresence.location')}</small><code title={presencePath}>{shortPath(presencePath, 52)}</code></span>}
    </div>

    {discovery?.presence === 'data-only' && <p className="agent-discovery-note">{t('toolPresence.dataOnlyHint')}</p>}
    {(discoveryError || discovery?.presence === 'error') && <p className="agent-discovery-note is-error" title={discoveryError || discovery?.reason}>{t('toolPresence.errorHint')}</p>}

    <section className="source-capture-control">
      <div>
        <h3>{packageNeedsRepair
          ? t('integration.repairTitle')
          : packageState?.installed
            ? t('integration.title')
            : t('integration.notAddedTitle')}</h3>
        <p>{!packageState
          ? t('integration.packageLifecycleUnavailable')
          : packageNeedsRepair
            ? t('integration.repairDescription')
            : packageState.installed
              ? packageState.restartRequired || management.enabled.restartRequired
                ? t('integration.pendingRestartDescription')
                : management.enabled.configured
                  ? t('integration.enabledDescription')
                  : t('integration.disabledDescription')
              : canInstall
                ? t('integration.notAddedDescription')
                : t('integration.notDetectedDescription')}</p>
        {error && <p className="source-capture-error">{error}</p>}
      </div>
      {!packageState
        ? <StatusBadge tone="danger">{t('status.managementUnavailable')}</StatusBadge>
        : packageNeedsRepair
          ? <Button variant="primary" loading={saving} onClick={() => void install()}>{t('integration.repair')}</Button>
          : packageReady
            ? <button
              type="button"
              role="switch"
              aria-checked={management.enabled.configured}
              className="source-capture-switch"
              data-enabled={management.enabled.configured || undefined}
              disabled={!management.enabled.editable || saving}
              onClick={() => void toggle()}
            ><span aria-hidden="true"/><b>{saving ? t('integration.saving') : management.enabled.configured ? t('integration.enabled') : t('integration.disabled')}</b></button>
            : <Button variant="primary" loading={saving} disabled={!canInstall} onClick={() => void install()}>{t('integration.addToAgentLens')}</Button>}
    </section>

    <section className="agent-primary-section integration-awaiting-detail">
      <div className="section-heading-row"><div><h3>{t('integration.detailsPendingTitle')}</h3><p>{packageNeedsRepair
        ? t('integration.detailsPendingRepair')
        : packageState?.installed
          ? t('integration.detailsPendingRestart')
          : t('integration.detailsPendingInstall')}</p></div></div>
    </section>

    <section className="agent-secondary">
      <IntegrationAdvancedActions
        management={management}
        label={management.displayName}
        onChange={onChange}
        onRemove={onRemove}
      />
    </section>
  </article>
}
