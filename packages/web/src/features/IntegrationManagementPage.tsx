import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import type {
  IntegrationManagementItemDto,
} from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { copyText } from '../client/clipboard'
import { useClientSnapshot } from '../client/use-client-snapshot'
import { AgentLogo } from '../components/AgentLogo'
import { useIntegrationOrder } from '../components/IntegrationOrderProvider'
import { AgentOrderActions, useAgentOrderDrag } from '../components/AgentOrderControls'
import { Button, Dialog, SelectMenu, StatusBadge, UiIcon } from '../components/ui'
import {
  agentUpgradeMethods,
  integrationAuthorizationSummary,
  integrationCanInstall,
  integrationPackageUpdateAvailable,
  integrationManagementLifecycleState,
  integrationLifecycleTone,
  integrationPackageReady,
  integrationToolPresenceLabel,
  integrationToolPresencePath,
} from './integrations/integration-lifecycle'
import { agentVersionComparison, checkAgentLatestVersion, type AgentLatestVersion } from './integrations/agent-online-versions'

const capabilityLabelKey: Record<string, string> = {
  source: 'integrationCapability.source',
  hook: 'integrationCapability.hook',
  runtime: 'integrationCapability.runtime',
  live: 'integrationCapability.live',
  assets: 'integrationCapability.assets',
}

function capabilityLabel(capability: string, t: TFunction): string {
  const key = capabilityLabelKey[capability]
  return key ? t(key) : capability
}

function isDetected(item: IntegrationManagementItemDto): boolean {
  return item.tool?.presence === 'present' || item.tool?.presence === 'data-only'
}

function isPrimaryRow(item: IntegrationManagementItemDto): boolean {
  return Boolean(item.packageState?.installed)
    || isDetected(item)
    || item.tool?.presence === 'error'
}

function IntegrationManagementDetail({
  item,
  model,
  discoveryScanning,
  discoveryError,
}: {
  item: IntegrationManagementItemDto
  model: AgentLensClientModel
  discoveryScanning: boolean
  discoveryError: string
}) {
  const { t } = useTranslation('agents')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removeMessage, setRemoveMessage] = useState('')
  const [updateOpen, setUpdateOpen] = useState(false)
  const [updateNotice, setUpdateNotice] = useState('')
  const [upgradeMethod, setUpgradeMethod] = useState(() => agentUpgradeMethods(item.productId)[0]?.value ?? '')
  const [copiedCommand, setCopiedCommand] = useState<'install' | 'update' | null>(null)
  const [latestVersion, setLatestVersion] = useState<AgentLatestVersion | null>(null)
  const [versionChecking, setVersionChecking] = useState(false)
  const packageState = item.packageState
  const packageReady = integrationPackageReady(packageState)
  const canUpdatePackage = integrationPackageUpdateAvailable(packageState)
  const methods = agentUpgradeMethods(item.productId)
  const selectedMethod = methods.find(method => method.value === upgradeMethod) ?? methods[0]
  // This view reports the installed executable version, not Source metadata or the Pi SDK package version.
  const versions = item.tool?.presence === 'present' && item.tool.version ? [item.tool.version] : []
  const localAgentVersion = versions.length ? versions.join(' / ') : t('installation.versionUnavailable')
  const versionComparison = agentVersionComparison(versions, latestVersion)
  const onlineVersionLabel = latestVersion?.status === 'ready' && latestVersion.version
    ? latestVersion.version
    : t(latestVersion?.status === 'error'
      ? 'managementPage.versionCheckFailedShort'
      : latestVersion?.status === 'unsupported'
        ? 'managementPage.versionCheckUnsupportedShort'
        : 'managementPage.versionCheckingShort')
  const canInstall = integrationCanInstall(item.tool)
  const status = integrationManagementLifecycleState(item, t)
  const statusLabel = item.isNew && !packageState?.installed && canInstall
    ? `${t('status.new')} · ${t('status.notAdded')}`
    : status.label
  const presencePath = integrationToolPresencePath(item.tool)
  const authorization = integrationAuthorizationSummary(item.capabilities)

  const installOrRepair = async () => {
    if (!packageState || saving) return
    setSaving(true)
    setError('')
    try {
      const result = await model.installIntegration(item.integrationId)
      if (result.operation.status !== 'completed' || !integrationPackageReady(result.state)) {
        throw new Error(result.operation.message || result.state.reason || t('integration.installFailed'))
      }
      await model.acknowledgeIntegration(item.integrationId).catch(() => undefined)
      await model.setIntegrationEnabled(item.integrationId, true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const updatePackage = async () => {
    if (!canUpdatePackage || saving || !packageState?.availableVersion) return
    setSaving(true)
    setError('')
    setUpdateNotice('')
    try {
      const result = await model.updateIntegration(item.integrationId)
      if (result.operation.status !== 'completed'
        || !integrationPackageReady(result.state)
        || result.state.installedVersion !== packageState.availableVersion) {
        throw new Error(result.operation.message || result.state.reason || t('managementPage.updateFailed'))
      }
      setUpdateOpen(false)
      setUpdateNotice(t(result.state.restartRequired ? 'managementPage.updateRestart' : 'managementPage.updateComplete'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    let active = true
    void checkAgentLatestVersion(item.productId).then(result => {
      if (active) setLatestVersion(result)
    })
    return () => { active = false }
  }, [item.productId])

  const refreshLatestVersion = async () => {
    if (versionChecking) return
    setVersionChecking(true)
    const result = await checkAgentLatestVersion(item.productId, { force: true })
    setLatestVersion(result)
    setVersionChecking(false)
  }

  const copyAgentUpgrade = async (kind: 'install' | 'update') => {
    if (!selectedMethod) return
    try {
      await copyText(kind === 'install' ? selectedMethod.installCommand : selectedMethod.updateCommand)
      setCopiedCommand(kind)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const setEnabled = async (enabled: boolean) => {
    if (!item.enabled.editable || saving) return
    setSaving(true)
    setError('')
    try {
      await model.setIntegrationEnabled(item.integrationId, enabled)
      if (enabled) await model.acknowledgeIntegration(item.integrationId).catch(() => undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const authorize = async () => {
    if (!authorization.pending.length || !item.enabled.configured || saving) return
    setSaving(true)
    setError('')
    try {
      await model.authorizeIntegration(item.productId, authorization.pending)
      await model.refreshIntegrationManagement().catch(() => undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!packageState?.installed || saving) return
    setSaving(true)
    setError('')
    setRemoveMessage('')
    try {
      if (item.enabled.configured) {
        await model.setIntegrationEnabled(item.integrationId, false)
      }
      if (item.enabled.effective) {
        setRemoveMessage(t('integration.uninstallRestartRequired'))
        return
      }
      const result = await model.removeIntegration(item.integrationId)
      if (result.operation.status !== 'completed' || result.state.installed) {
        throw new Error(result.operation.message || result.state.reason || t('integration.uninstallFailed'))
      }
      setRemoveOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const primaryAction = !packageState
    ? null
    : !packageReady
      ? packageState.installed || canInstall
        ? <Button
            variant="primary"
            loading={saving}
            onClick={() => void installOrRepair()}
          >
            {packageState.installed ? t('integration.repair') : t('managementPage.add')}
          </Button>
        : null
      : <Button
          variant={item.enabled.configured ? 'danger' : 'primary'}
          loading={saving}
          disabled={!item.enabled.editable}
          onClick={() => void setEnabled(!item.enabled.configured)}
        >
          <UiIcon name="power" size={14}/>
          {item.enabled.configured ? t('managementPage.disableIntegration') : t('managementPage.enableIntegration')}
        </Button>

  return <section className="integration-management-detail-card" data-integration={item.integrationId}>
    <header className="integration-management-detail-head">
      <div className="integration-management-identity">
        <AgentLogo sourceId={item.integrationId} size="large"/>
        <span className="integration-management-identity-text">
          <h2>{item.displayName}</h2>
          <small>{integrationToolPresenceLabel(item.tool, discoveryScanning, discoveryError, t)}</small>
        </span>
      </div>
      <div className="integration-management-detail-head-meta">
        {versionComparison === 'newer' && <StatusBadge tone="warning">{t('managementPage.versionUpdateAvailable')}</StatusBadge>}
        <StatusBadge
          className="integration-management-status"
          tone={integrationLifecycleTone(status.className, item.isNew)}
          title={status.title}
        >{statusLabel}</StatusBadge>
      </div>
    </header>
    <div className="integration-management-version-strip" role="status">
      <span title={t('managementPage.localAgentVersion')}>{t('managementPage.versionInstalledShort')} <b>{localAgentVersion}</b></span>
      <span title={latestVersion?.status === 'ready'
        ? t('managementPage.remoteAgentVersion', { source: latestVersion.source === 'github' ? 'GitHub' : 'npm', version: onlineVersionLabel })
        : onlineVersionLabel}>{t('managementPage.versionLatestShort')} <b>{onlineVersionLabel}</b></span>
    </div>
      <div className="integration-management-details">
        <div className="integration-management-facts" aria-label={t('managementPage.detailsLabel')}>
          <div className="integration-management-fact">
            <span>{t('toolPresence.label')}</span>
            <strong>{integrationToolPresenceLabel(item.tool, discoveryScanning, discoveryError, t)}</strong>
            {item.tool?.presence === 'data-only' && <small>{t('toolPresence.dataOnlyHint')}</small>}
          </div>
          <div className="integration-management-fact">
            <span>{t('toolPresence.location')}</span>
            <code title={presencePath}>{presencePath || t('installation.pathUnavailable')}</code>
          </div>
          <div className="integration-management-fact">
            <span>{t('installation.integrationVersion')}</span>
            <strong>{!packageState
              ? t('installation.versionUnavailable')
              : !packageState.installed
                ? t('installation.notAdded')
                : packageState.installedVersion || t('installation.versionUnavailable')}</strong>
          </div>
          <div className="integration-management-fact">
            <span>{t('managementPage.availableIntegrationVersion')}</span>
            <strong>{packageState?.availableVersion || t('installation.versionUnavailable')}</strong>
          </div>
        </div>

        <div className="integration-management-agent-upgrade">
          <span className="integration-management-detail-label">{t('managementPage.agentUpgradeHeading')}</span>
          <div className="integration-management-version-check">
            {latestVersion?.status !== 'unsupported' && <Button size="small" disabled={versionChecking} loading={versionChecking}
              onClick={() => void refreshLatestVersion()}>{t('managementPage.checkVersion')}</Button>}
            {versionComparison === 'current' && <span className="integration-management-version-hint">{t('managementPage.versionCurrent')}</span>}
            {versionComparison === 'unknown' && latestVersion?.status === 'ready' && <span className="integration-management-version-hint">{t('managementPage.versionComparisonUnknown')}</span>}
            {latestVersion?.status === 'error' && <span className="integration-management-version-hint">{t('managementPage.versionCheckFailed')}</span>}
          </div>
          <p>{t('managementPage.agentUpgradeWarning')}</p>
          {methods.length > 0
            ? <>
              <div className="workspace-view-tabs is-inline integration-management-upgrade-method" role="tablist"
                aria-label={t('managementPage.agentUpgradeMethod')}
                onKeyDown={event => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const currentIndex = Math.max(0, methods.findIndex(method => method.value === selectedMethod?.value))
                  const nextIndex = event.key === 'Home' ? 0
                    : event.key === 'End' ? methods.length - 1
                      : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + methods.length) % methods.length
                  const nextMethod = methods[nextIndex]
                  setUpgradeMethod(nextMethod.value)
                  setCopiedCommand(null)
                  event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus()
                }}
              >
                {methods.map(method => <button
                  key={method.value}
                  type="button"
                  role="tab"
                  id={`integration-upgrade-tab-${item.integrationId}-${method.value}`}
                  aria-controls={`integration-upgrade-panel-${item.integrationId}`}
                  aria-selected={selectedMethod?.value === method.value}
                  tabIndex={selectedMethod?.value === method.value ? 0 : -1}
                  className={`workspace-view-tab ${selectedMethod?.value === method.value ? 'is-active' : ''}`}
                  onClick={() => { setUpgradeMethod(method.value); setCopiedCommand(null) }}
                >{t(`managementPage.method.${method.labelKey}`)}</button>)}
              </div>
              {selectedMethod && <div
                className="integration-management-command-pair"
                role="tabpanel"
                id={`integration-upgrade-panel-${item.integrationId}`}
                aria-labelledby={`integration-upgrade-tab-${item.integrationId}-${selectedMethod.value}`}
              >
                <div className="integration-management-command">
                  <span className="integration-management-detail-label">{t('managementPage.installCommand')}</span>
                  <code>{selectedMethod.installCommand}</code>
                  <Button size="small" onClick={() => void copyAgentUpgrade('install')}>
                    {t(copiedCommand === 'install' ? 'managementPage.copiedCommand' : 'managementPage.copyCommand')}
                  </Button>
                </div>
                <div className="integration-management-command">
                  <span className="integration-management-detail-label">{t('managementPage.upgradeCommand')}</span>
                  <code>{selectedMethod.updateCommand}</code>
                  <Button size="small" onClick={() => void copyAgentUpgrade('update')}>
                    {t(copiedCommand === 'update' ? 'managementPage.copiedCommand' : 'managementPage.copyCommand')}
                  </Button>
                </div>
                <a href={selectedMethod.docsUrl} target="_blank" rel="noopener noreferrer">{t('managementPage.officialUpgradeDocs')}</a>
              </div>}
            </>
            : <small>{t('managementPage.agentUpgradeUnavailable')}</small>}
        </div>

        <div className="integration-management-detail-section">
          <span className="integration-management-detail-label">{t('managementPage.columnCapabilities')}</span>
          <div className="integration-management-capabilities">
            {item.capabilities.length
              ? item.capabilities.map(capability => <span key={capability.capability} className="integration-management-capability">
                  {capabilityLabel(capability.capability, t)}
                </span>)
              : <span className="integration-management-capability is-muted">{t('managementPage.capabilitiesPending')}</span>}
          </div>
        </div>

        <div className="integration-management-actions" aria-label={t('managementPage.actionsLabel')}>
          <div className="integration-management-actions-info">
            <span className="integration-management-actions-label">{t('managementPage.actionsLabel')}</span>
            <div className="integration-management-authorization-status" role="status">
              <span>{t('managementPage.authorizationStatus')}</span>
              <StatusBadge tone={authorization.phase === 'granted' ? 'success'
                : authorization.phase === 'required' || authorization.phase === 'restart-required' ? 'warning' : 'neutral'}>
                {t(`managementPage.authorizationState.${authorization.phase}`)}
              </StatusBadge>
              {authorization.controlled.length > 0 && <span className="integration-management-authorization-capabilities">
                {authorization.controlled.map(capability => capabilityLabel(capability.capability, t)).join(' / ')}
              </span>}
            </div>
            {authorization.phase === 'restart-required' && <small>{t('managementPage.authorizationRestartHint')}</small>}
            {authorization.phase === 'unknown' && <small>{t('managementPage.authorizationUnknownHint')}</small>}
            {authorization.phase === 'granted' && <small>{t('managementPage.authorizationGrantedHint')}</small>}
            {authorization.phase === 'required' && !item.enabled.configured && <small>{t('managementPage.authorizationEnableHint')}</small>}
          </div>
          <div className="integration-management-action-buttons">
            {authorization.phase === 'required' && <Button
              variant="primary"
              disabled={saving || !item.enabled.configured}
              onClick={() => void authorize()}
            ><UiIcon name="settings" size={14}/>{t('managementPage.authorizeIntegration')}</Button>}
            {canUpdatePackage && <Button
              disabled={saving}
              onClick={() => { setError(''); setUpdateOpen(true) }}
            >{t('managementPage.updateIntegration')}</Button>}
            {primaryAction}
            {packageState?.installed && !item.enabled.configured && <Button
              variant="danger"
              disabled={saving}
              onClick={() => {
                setRemoveMessage('')
                setError('')
                setRemoveOpen(true)
              }}
            >{t('managementPage.uninstall')}</Button>}
          </div>
        </div>
        {updateNotice && <p className="integration-management-note" role="status">{updateNotice}</p>}
        {error && <p className="integration-management-error" role="alert">{error}</p>}
      </div>
    <Dialog
      open={updateOpen}
      title={t('managementPage.updateDialogTitle', { agent: item.displayName })}
      description={t('managementPage.updateDialogDescription', {
        current: packageState?.installedVersion ?? '',
        available: packageState?.availableVersion ?? '',
      })}
      onClose={() => { if (!saving) setUpdateOpen(false) }}
      closeDisabled={saving}
      footer={<>
        <Button disabled={saving} onClick={() => setUpdateOpen(false)}>{t('integration.cancel')}</Button>
        <Button variant="primary" loading={saving} onClick={() => void updatePackage()}>
          {t('managementPage.confirmUpdate')}
        </Button>
      </>}
    >
      <p className="integration-management-note">{t('managementPage.updateScope')}</p>
    </Dialog>
    <Dialog
      open={removeOpen}
      title={t('integration.uninstallDialogTitle', { agent: item.displayName })}
      description={t('integration.uninstallDialogDescription')}
      onClose={() => { if (!saving) setRemoveOpen(false) }}
      closeDisabled={saving}
      footer={<>
        <Button disabled={saving} onClick={() => setRemoveOpen(false)}>{t('integration.cancel')}</Button>
        <Button variant="danger" loading={saving} onClick={() => void remove()}>
          {item.enabled.effective ? t('integration.disableBeforeUninstall') : t('integration.confirmUninstall')}
        </Button>
      </>}
    >
      {removeMessage && <p className="integration-management-note">{removeMessage}</p>}
      <p className="integration-management-note">{t('integration.uninstallKeepsHistory')}</p>
    </Dialog>
  </section>
}

/** Compact, selectable navigator; lifecycle commands live exclusively in the detail pane. */
function IntegrationManagementListItem({
  item,
  selected,
  discoveryScanning,
  discoveryError,
  onSelect,
}: {
  item: IntegrationManagementItemDto
  selected: boolean
  discoveryScanning: boolean
  discoveryError: string
  onSelect(): void
}) {
  const { t } = useTranslation('agents')
  const [latestVersion, setLatestVersion] = useState<AgentLatestVersion | null>(null)
  useEffect(() => {
    let active = true
    void checkAgentLatestVersion(item.productId).then(result => {
      if (active) setLatestVersion(result)
    })
    return () => { active = false }
  }, [item.productId])
  const status = integrationManagementLifecycleState(item, t)
  const versions = item.tool?.presence === 'present' && item.tool.version ? [item.tool.version] : []
  const hasUpgrade = agentVersionComparison(versions, latestVersion) === 'newer'
  return <button
    type="button"
    className="integration-management-list-item"
    data-selected={selected ? 'true' : undefined}
    aria-current={selected ? 'true' : undefined}
    onClick={onSelect}
  >
    <AgentLogo sourceId={item.integrationId} size="compact"/>
    <span className="integration-management-list-item-main">
      <strong>{item.displayName}</strong>
      <small title={hasUpgrade ? t('managementPage.versionUpdateAvailable') : undefined}>
        {versions.length ? t('managementPage.versionInstalledShort') + ' ' + versions.join(' / ')
          : integrationToolPresenceLabel(item.tool, discoveryScanning, discoveryError, t)}
        {hasUpgrade && <span className="integration-management-update-text"> · {t('managementPage.versionUpdateAvailable')}</span>}
      </small>
    </span>
    <span className="integration-management-list-item-status">
      {hasUpgrade && <UiIcon name="exclamation" size={14} className="integration-management-update-icon" aria-label={t('managementPage.versionUpdateAvailable')}/>}
      <StatusBadge tone={integrationLifecycleTone(status.className, item.isNew)}
        title={status.title}>{status.label}</StatusBadge>
    </span>
    <UiIcon name="chevron-right" size={14} className="integration-management-list-chevron"/>
  </button>
}

export function IntegrationManagementPage({ model, toolbarHost }: { model: AgentLensClientModel; toolbarHost?: HTMLDivElement | null }) {
  const { t } = useTranslation('agents')
  const snapshot = useClientSnapshot(model)
  const [searchParams, setSearchParams] = useSearchParams()
  const targetIntegrationId = searchParams.get('agent') ?? ''
  const management = snapshot.integrationManagement
  const [ordering, setOrdering] = useState(false)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(Boolean(targetIntegrationId))
  const [statusFilter, setStatusFilter] = useState<'all' | 'detected' | 'installed' | 'enabled'>('all')
  const [visibleNewIds, setVisibleNewIds] = useState<Set<string>>(() => new Set())
  const acknowledgementInFlightRef = useRef(false)
  const detailPaneRef = useRef<HTMLElement | null>(null)
  const { ordered, reset } = useIntegrationOrder()
  const { draggedId, dragProps, cancelDrag } = useAgentOrderDrag()

  useEffect(() => {
    if (!management || acknowledgementInFlightRef.current) return
    const newIds = management.items.filter(item => item.isNew).map(item => item.integrationId)
    if (!newIds.length) return

    setVisibleNewIds(current => {
      const next = new Set(current)
      for (const id of newIds) next.add(id)
      return next
    })

    acknowledgementInFlightRef.current = true
    const acknowledgedIntegrationIds = [...new Set([
      ...management.preferences.acknowledgedIntegrationIds,
      ...newIds,
    ])]
    void model.updateIntegrationPreferences({ acknowledgedIntegrationIds }).then(
      () => { acknowledgementInFlightRef.current = false },
      () => { acknowledgementInFlightRef.current = false },
    )
  }, [management, model])

  useEffect(() => {
    if (targetIntegrationId) setMobileDetailOpen(true)
  }, [targetIntegrationId])

  const items = useMemo(() => {
    const rows = [...(management?.items ?? [])]
    const orderIndex = new Map(ordered.map((id, index) => [id, index]))
    rows.sort((left, right) =>
      (orderIndex.get(left.integrationId) ?? left.displayOrder ?? Number.MAX_SAFE_INTEGER)
        - (orderIndex.get(right.integrationId) ?? right.displayOrder ?? Number.MAX_SAFE_INTEGER)
      || left.integrationId.localeCompare(right.integrationId)
    )
    return rows
  }, [management?.items, ordered])

  const discoveryScanning = snapshot.integrationDiscoveryLoading
    || snapshot.integrationDiscoveryRescanning
    || management?.discovery.status === 'scanning'
  const discoveryFailed = Boolean(snapshot.integrationDiscoveryError)
  const filteredItems = items.filter(item => {
    if (statusFilter === 'detected') return isDetected(item)
    if (statusFilter === 'installed') return Boolean(item.packageState?.installed)
    if (statusFilter === 'enabled') return item.enabled.configured
    return true
  })
  const primaryItems = filteredItems.filter(item => discoveryFailed || isPrimaryRow(item))
  const supportedItems = discoveryFailed ? [] : filteredItems.filter(item => !isPrimaryRow(item))
  const detectedCount = items.filter(isDetected).length
  const installedCount = items.filter(item => item.packageState?.installed).length
  const enabledCount = items.filter(item => item.enabled.configured).length
  const selectedItem = filteredItems.find(item =>
    item.integrationId === targetIntegrationId || item.productId === targetIntegrationId
  ) ?? primaryItems[0] ?? supportedItems[0]

  const selectItem = (integrationId: string) => {
    setMobileDetailOpen(true)
    if (integrationId === targetIntegrationId) return
    const next = new URLSearchParams(searchParams)
    next.set('agent', integrationId)
    setSearchParams(next)
  }

  useEffect(() => {
    if (detailPaneRef.current) detailPaneRef.current.scrollTop = 0
  }, [selectedItem?.integrationId])

  if (!management) {
    return <main className="workspace-page">
      <div className="page-content integration-management-content">
        <div className="empty-state roomy">{snapshot.integrationManagementError || t('managementPage.loading')}</div>
      </div>
    </main>
  }

  return <main className="workspace-page">
    {toolbarHost ? createPortal(
      <div className="workspace-view-controls" aria-label={t('managementPage.summaryAria')}>
        <div className="workspace-view-filter workspace-view-filter-time">
          <SelectMenu value={statusFilter} onChange={value => { setStatusFilter(value as typeof statusFilter); setOrdering(false) }} ariaLabel={t('managementPage.statusFilterAria')} options={[
            { value: 'all', label: t('managementPage.allStatuses') },
            { value: 'detected', label: t('managementPage.detected') },
            { value: 'installed', label: t('managementPage.added') },
            { value: 'enabled', label: t('managementPage.enabled') },
          ]}/>
        </div>
        <div className="workspace-view-filter-actions">
          <Button size="small" onClick={() => { setStatusFilter('all'); setOrdering(value => !value) }}>
            {ordering ? t('page.orderDone') : t('page.manageOrder')}
          </Button>
        </div>
      </div>,
      toolbarHost,
    ) : null}
    <div className="page-content integration-management-content">
      <div className="integration-management-surface">
        {ordering ? <section className="integration-management-section" aria-label={t('page.orderTitle')}>
          <div className="integration-management-section-head">
            <h2>{t('page.orderTitle')}</h2>
            <span className="integration-management-order-hint">{t('scope.reorderHint')}</span>
            <Button size="small" onClick={() => { reset(); cancelDrag() }}>{t('scope.reset')}</Button>
          </div>
          <div className="integration-management-order-list">
            {items.map((item, index) => {
              const status = integrationManagementLifecycleState(item, t)
              return <div key={item.integrationId}
                className="integration-management-order-row"
                data-dragging={draggedId === item.integrationId ? 'true' : undefined}
                {...dragProps(item.integrationId)}
              >
                <UiIcon name="drag" size={16} className="integration-management-order-grip"/>
                <span className="integration-management-order-number">{index + 1}</span>
                <AgentLogo sourceId={item.integrationId} size="compact"/>
                <span className="integration-management-order-name">{item.displayName}</span>
                <StatusBadge tone={integrationLifecycleTone(status.className, item.isNew)}>{status.label}</StatusBadge>
                <AgentOrderActions sourceId={item.integrationId} label={item.displayName} className="integration-management-order-buttons"/>
              </div>
            })}
          </div>
        </section> : <div className="integration-management-workspace" data-mobile-detail={mobileDetailOpen ? 'true' : 'false'}>
          {/* Agent navigator and selected detail are separate scrolling panes. */}
          <aside className="integration-management-navigator" aria-label={t('managementPage.agentListAria')}>
            <div className="integration-management-navigator-head">
              <strong>{t('managementPage.agentListTitle')}</strong>
              <span>{items.length}</span>
            </div>
            <div className="integration-management-summary" aria-label={t('managementPage.summaryAria')}>
              <span><strong>{discoveryFailed ? '—' : detectedCount}</strong> {t('managementPage.detected')}</span>
              <span><strong>{installedCount}</strong> {t('managementPage.added')}</span>
              <span><strong>{enabledCount}</strong> {t('managementPage.enabled')}</span>
            </div>
            <nav className="integration-management-navigator-list" aria-label={t('managementPage.agentListAria')}>
              {primaryItems.length > 0 && <div className="integration-management-list-group">
                <h3>{t('managementPage.localAndAdded')} <small>{primaryItems.length}</small></h3>
                {primaryItems.map(item => <IntegrationManagementListItem
                  key={item.integrationId}
                  item={{ ...item, isNew: item.isNew || visibleNewIds.has(item.integrationId) }}
                  selected={selectedItem?.integrationId === item.integrationId}
                  discoveryScanning={Boolean(discoveryScanning)}
                  discoveryError={snapshot.integrationDiscoveryError}
                  onSelect={() => selectItem(item.integrationId)}
                />)}
              </div>}
              {supportedItems.length > 0 && <div className="integration-management-list-group">
                <h3>{t('managementPage.otherSupported')} <small>{supportedItems.length}</small></h3>
                {supportedItems.map(item => <IntegrationManagementListItem
                  key={item.integrationId}
                  item={{ ...item, isNew: item.isNew || visibleNewIds.has(item.integrationId) }}
                  selected={selectedItem?.integrationId === item.integrationId}
                  discoveryScanning={Boolean(discoveryScanning)}
                  discoveryError={snapshot.integrationDiscoveryError}
                  onSelect={() => selectItem(item.integrationId)}
                />)}
              </div>}
              {!primaryItems.length && !supportedItems.length && <div className="integration-management-empty">
                {statusFilter !== 'all' ? t('managementPage.noMatches') : t('managementPage.noLocalOrAdded')}
              </div>}
            </nav>
          </aside>
          <section ref={detailPaneRef} className="integration-management-detail-pane" aria-label={t('managementPage.detailsLabel')}>
            <div className="integration-management-mobile-back">
              <Button size="small" onClick={() => setMobileDetailOpen(false)}>
                <UiIcon name="arrow-left" size={14}/>{t('managementPage.backToAgents')}
              </Button>
            </div>
            {selectedItem ? <IntegrationManagementDetail
              key={selectedItem.integrationId}
              item={{ ...selectedItem, isNew: selectedItem.isNew || visibleNewIds.has(selectedItem.integrationId) }}
              model={model}
              discoveryScanning={Boolean(discoveryScanning)}
              discoveryError={snapshot.integrationDiscoveryError}
            /> : <div className="integration-management-empty">{t('managementPage.noMatches')}</div>}
          </section>
        </div>}
      </div>
    </div>
  </main>
}
