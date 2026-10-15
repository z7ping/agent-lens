import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import type {
  AgentInstallationOverviewDto,
  IntegrationAuthorizationCapabilityDto,
  IntegrationManagementItemDto,
} from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { copyText } from '../client/clipboard'
import { useClientSnapshot } from '../App'
import { AgentLogo } from '../components/AgentLogo'
import { useIntegrationOrder } from '../components/IntegrationOrderProvider'
import { Button, Dialog, Disclosure, IconButton, Input, SelectMenu, StatusBadge, UiIcon } from '../components/ui'
import {
  agentUpgradeMethods,
  integrationCanInstall,
  integrationPackageUpdateAvailable,
  integrationManagementLifecycleState,
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

function IntegrationManagementRow({
  item,
  installations,
  moveUpTargetId,
  moveDownTargetId,
  model,
  discoveryScanning,
  discoveryError,
  ordering,
  highlighted,
}: {
  item: IntegrationManagementItemDto
  installations?: readonly AgentInstallationOverviewDto[]
  moveUpTargetId?: string | undefined
  moveDownTargetId?: string | undefined
  model: AgentLensClientModel
  discoveryScanning: boolean
  discoveryError: string
  ordering: boolean
  highlighted: boolean
}) {
  const { t } = useTranslation('agents')
  const { move } = useIntegrationOrder()
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
  const [expanded, setExpanded] = useState(highlighted || ordering)

  useEffect(() => {
    if (highlighted || ordering) setExpanded(true)
  }, [highlighted, ordering])

  const packageState = item.packageState
  const packageReady = integrationPackageReady(packageState)
  const canUpdatePackage = integrationPackageUpdateAvailable(packageState)
  const methods = agentUpgradeMethods(item.productId)
  const selectedMethod = methods.find(method => method.value === upgradeMethod) ?? methods[0]
  const versions = [...new Set((installations ?? []).map(installation => installation.version).filter((version): version is string => Boolean(version)))]
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
  const pendingAuthorization = item.capabilities
    .filter(capability => capability.authorization === 'required')
    .map(capability => capability.capability)
    .filter((capability): capability is IntegrationAuthorizationCapabilityDto =>
      capability === 'hook' || capability === 'runtime' || capability === 'live'
    )

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
    if (!pendingAuthorization.length || saving) return
    setSaving(true)
    setError('')
    try {
      await model.authorizeIntegration(item.productId, pendingAuthorization)
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
            size="small"
            variant="primary"
            loading={saving}
            onClick={() => void installOrRepair()}
          >
            {packageState.installed ? t('integration.repair') : t('managementPage.add')}
          </Button>
        : null
      : <Button
          size="small"
          loading={saving}
          disabled={!item.enabled.editable}
          onClick={() => void setEnabled(!item.enabled.configured)}
        >
          {item.enabled.configured ? t('managementPage.disable') : t('managementPage.enable')}
        </Button>

  return <article
    className="integration-management-row"
    data-integration={item.integrationId}
    data-new={item.isNew ? 'true' : undefined}
    data-target={highlighted ? 'true' : undefined}
  >
    <Disclosure
      className="integration-management-disclosure"
      open={expanded}
      onToggle={event => setExpanded(event.currentTarget.open)}
      summary={<span className="integration-management-identity">
        <AgentLogo sourceId={item.integrationId} size="large"/>
        <span className="integration-management-identity-text">
          <b>{item.displayName}</b>
          <small>{integrationToolPresenceLabel(item.tool, discoveryScanning, discoveryError, t)}</small>
        </span>
      </span>}
      summaryMeta={<span className="integration-management-summary-states">
        <span className="integration-management-version-summary" role="status">
          <span title={t('managementPage.localAgentVersion')}>{t('managementPage.versionInstalledShort')} <b>{localAgentVersion}</b></span>
          <span title={t('managementPage.remoteAgentVersion', { source: latestVersion?.source === 'github' ? 'GitHub' : 'npm', version: onlineVersionLabel })}>{t('managementPage.versionLatestShort')} <b>{onlineVersionLabel}</b></span>
        </span>
        {versionComparison === 'newer' && <StatusBadge tone="warning">{t('managementPage.versionUpdateAvailable')}</StatusBadge>}
        <StatusBadge
          className={`integration-management-status ${status.className}`}
          tone={status.className.includes('error')
            ? 'danger'
            : status.className.includes('enabled')
              ? 'success'
              : status.className.includes('history') || status.className.includes('scanning')
                ? 'warning'
                : item.isNew
                  ? 'accent'
                  : 'neutral'}
          title={status.title}
        >{statusLabel}</StatusBadge>
      </span>}
    >
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
              <div className="integration-management-upgrade-method">
                <SelectMenu
                  value={selectedMethod?.value ?? ''}
                  ariaLabel={t('managementPage.agentUpgradeMethod')}
                  onChange={value => { setUpgradeMethod(value); setCopiedCommand(null) }}
                  options={methods.map(method => ({ value: method.value, label: t(`managementPage.method.${method.labelKey}`) }))}
                />
              </div>
              {selectedMethod && <div className="integration-management-command-pair">
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

        {(primaryAction || canUpdatePackage || (pendingAuthorization.length > 0 && item.enabled.configured) || (packageState?.installed && !item.enabled.configured) || ordering) && <div className="integration-management-actions">
          {pendingAuthorization.length > 0 && item.enabled.configured && <Button
            size="small"
            disabled={saving}
            onClick={() => void authorize()}
          >{t('managementPage.authorize')}</Button>}
          {primaryAction}
          {canUpdatePackage && <Button
            size="small"
            disabled={saving}
            onClick={() => { setError(''); setUpdateOpen(true) }}
          >{t('managementPage.updateIntegration')}</Button>}
          {packageState?.installed && !item.enabled.configured && <Button
            size="small"
            variant="danger"
            disabled={saving}
            onClick={() => {
              setRemoveMessage('')
              setError('')
              setRemoveOpen(true)
            }}
          >{t('managementPage.uninstall')}</Button>}
          {ordering && <span className="integration-management-order-actions" aria-label={t('managementPage.orderAria')}>
            <IconButton
              size="small"
              aria-label={t('managementPage.moveUp', { agent: item.displayName })}
              disabled={!moveUpTargetId}
              onClick={() => { if (moveUpTargetId) move(item.integrationId, moveUpTargetId) }}
            ><UiIcon name="sort-up" size={14}/></IconButton>
            <IconButton
              size="small"
              aria-label={t('managementPage.moveDown', { agent: item.displayName })}
              disabled={!moveDownTargetId}
              onClick={() => { if (moveDownTargetId) move(item.integrationId, moveDownTargetId) }}
            ><UiIcon name="sort-down" size={14}/></IconButton>
          </span>}
        </div>}
        {updateNotice && <p className="integration-management-note" role="status">{updateNotice}</p>}
        {error && <p className="integration-management-error" role="alert">{error}</p>}
      </div>
    </Disclosure>

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
  </article>
}

export function IntegrationManagementPage({ model, toolbarHost }: { model: AgentLensClientModel; toolbarHost?: HTMLDivElement | null }) {
  const { t } = useTranslation('agents')
  const snapshot = useClientSnapshot(model)
  const [searchParams] = useSearchParams()
  const targetIntegrationId = searchParams.get('agent') ?? ''
  const management = snapshot.integrationManagement
  const [ordering, setOrdering] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'detected' | 'installed' | 'enabled'>('all')
  const [visibleNewIds, setVisibleNewIds] = useState<Set<string>>(() => new Set())
  const acknowledgementInFlightRef = useRef(false)
  const { ordered } = useIntegrationOrder()

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
    if (!targetIntegrationId || !management) return
    const timer = window.setTimeout(() => {
      const target = [...document.querySelectorAll<HTMLElement>('[data-integration]')]
        .find(node => node.dataset.integration === targetIntegrationId)
      target?.scrollIntoView({ block: 'center', behavior: 'auto' })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [management, targetIntegrationId])

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
    const query = searchQuery.trim().toLocaleLowerCase()
    if (query && ![item.displayName, item.integrationId, item.productId]
      .some(text => text.toLocaleLowerCase().includes(query))) return false
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

  // The management summary has only presence/path facts; installation versions
  // arrive through Agent detail. Hydrate discovered agents without requiring
  // users to open each overview page first.
  useEffect(() => {
    if (!management || !snapshot.agentSummaries) return
    for (const item of management.items) {
      if (item.tool?.presence !== 'present') continue
      const source = snapshot.agentSummaries.items.find(agent => agent.productId === item.productId)
      if (source) void model.ensureAgentDetail(source.sourceId).catch(() => undefined)
    }
  }, [management, snapshot.agentSummaries, model])

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
        <div className="workspace-view-filter">
          <Input value={searchQuery} onChange={event => { setSearchQuery(event.target.value); setOrdering(false) }} aria-label={t('managementPage.searchAria')} placeholder={t('managementPage.searchPlaceholder')}/>
        </div>
        <div className="workspace-view-filter workspace-view-filter-time">
          <SelectMenu value={statusFilter} onChange={value => { setStatusFilter(value as typeof statusFilter); setOrdering(false) }} ariaLabel={t('managementPage.statusFilterAria')} options={[
            { value: 'all', label: t('managementPage.allStatuses') },
            { value: 'detected', label: t('managementPage.detected') },
            { value: 'installed', label: t('managementPage.added') },
            { value: 'enabled', label: t('managementPage.enabled') },
          ]}/>
        </div>
        <div className="workspace-view-filter-actions">
          <Button size="small" disabled={Boolean(searchQuery.trim()) || statusFilter !== 'all'} onClick={() => setOrdering(value => !value)}>
            {ordering ? t('page.orderDone') : t('page.manageOrder')}
          </Button>
        </div>
      </div>,
      toolbarHost,
    ) : null}
    <div className="page-content integration-management-content">
      <div className="integration-management-surface">
        <div className="integration-management-summary" aria-label={t('managementPage.summaryAria')}>
          <span><strong>{items.length}</strong><small>{t('managementPage.supported')}</small></span>
          <span><strong>{discoveryFailed ? '—' : detectedCount}</strong><small>{t('managementPage.detected')}</small></span>
          <span><strong>{installedCount}</strong><small>{t('managementPage.added')}</small></span>
          <span><strong>{enabledCount}</strong><small>{t('managementPage.enabled')}</small></span>
        </div>

        <section className="integration-management-section">
          <div className="integration-management-section-head">
            <h2>{t('managementPage.localAndAdded')}</h2>
            <span className="integration-management-section-count">{primaryItems.length}</span>
          </div>
          <div className="integration-management-list">
          {primaryItems.map((item, index) => <IntegrationManagementRow
            key={item.integrationId}
            item={{ ...item, isNew: item.isNew || visibleNewIds.has(item.integrationId) }}
            installations={snapshot.agents?.items.find(agent => agent.productId === item.productId)?.installations}
            moveUpTargetId={primaryItems[index - 1]?.integrationId}
            moveDownTargetId={primaryItems[index + 1]?.integrationId}
            model={model}
            discoveryScanning={Boolean(discoveryScanning)}
            discoveryError={snapshot.integrationDiscoveryError}
            ordering={ordering}
            highlighted={item.integrationId === targetIntegrationId}
          />)}
          {!primaryItems.length && <div className="integration-management-empty">{supportedItems.length === 0 && (searchQuery.trim() || statusFilter !== 'all') ? t('managementPage.noMatches') : t('managementPage.noLocalOrAdded')}</div>}
          </div>
        </section>

        {supportedItems.length > 0 && <section className="integration-management-section integration-management-section-secondary">
          <div className="integration-management-section-head">
            <h2>{t('managementPage.otherSupported')}</h2>
            <span className="integration-management-section-count">{supportedItems.length}</span>
          </div>
          <div className="integration-management-list">
            {supportedItems.map((item, index) => <IntegrationManagementRow
              key={item.integrationId}
              item={{ ...item, isNew: item.isNew || visibleNewIds.has(item.integrationId) }}
              installations={snapshot.agents?.items.find(agent => agent.productId === item.productId)?.installations}
              moveUpTargetId={supportedItems[index - 1]?.integrationId}
              moveDownTargetId={supportedItems[index + 1]?.integrationId}
              model={model}
              discoveryScanning={Boolean(discoveryScanning)}
              discoveryError={snapshot.integrationDiscoveryError}
              ordering={ordering}
              highlighted={item.integrationId === targetIntegrationId}
            />)}
          </div>
        </section>}
      </div>
    </div>
  </main>
}
