import { useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type {
  IntegrationAuthorizationCapabilityDto,
  IntegrationManagementItemDto,
} from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { sourceDot } from '../components/AgentScope'
import { useIntegrationOrder } from '../components/IntegrationOrderProvider'
import { Button, Dialog, IconButton, StatusBadge, UiIcon } from '../components/ui'
import {
  integrationCanInstall,
  integrationLifecycleState,
  integrationPackageReady,
  integrationToolPresenceLabel,
  integrationToolPresencePath,
} from './integrations/integration-lifecycle'

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
  index,
  total,
  model,
  discoveryScanning,
  discoveryError,
}: {
  item: IntegrationManagementItemDto
  index: number
  total: number
  model: AgentLensClientModel
  discoveryScanning: boolean
  discoveryError: string
}) {
  const { t } = useTranslation('agents')
  const { moveBy } = useIntegrationOrder()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removeMessage, setRemoveMessage] = useState('')

  const packageState = item.packageState
  const packageReady = integrationPackageReady(packageState)
  const canInstall = integrationCanInstall(item.tool)
  const detected = isDetected(item)
  const status = integrationLifecycleState(
    { supported: true, enabled: item.enabled.effective, detected },
    item,
    item.tool,
    discoveryScanning,
    t,
    discoveryError,
  )
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
      ? <Button
          size="small"
          variant={canInstall || packageState.installed ? 'primary' : 'default'}
          loading={saving}
          disabled={!packageState.installed && !canInstall}
          onClick={() => void installOrRepair()}
        >
          {packageState.installed ? t('integration.repair') : t('managementPage.add')}
        </Button>
      : <Button
          size="small"
          loading={saving}
          disabled={!item.enabled.editable}
          onClick={() => void setEnabled(!item.enabled.configured)}
        >
          {item.enabled.configured ? t('managementPage.disable') : t('managementPage.enable')}
        </Button>

  return <article className="integration-management-row" data-integration={item.integrationId}>
    <div className="integration-management-identity">
      <span className={`source-dot ${sourceDot(item.integrationId)}`} aria-hidden="true"/>
      <div>
        <b>{item.displayName}</b>
        <small title={presencePath}>{presencePath || t('managementPage.officialSupport')}</small>
      </div>
    </div>

    <div className="integration-management-detection">
      <span>{integrationToolPresenceLabel(item.tool, discoveryScanning, discoveryError, t)}</span>
      {item.tool?.presence === 'data-only' && <small>{t('toolPresence.dataOnlyHint')}</small>}
    </div>

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
    >
      {statusLabel}
    </StatusBadge>

    <div className="integration-management-capabilities">
      {item.capabilities.length
        ? item.capabilities.map(capability => <span key={capability.capability} className="integration-management-capability">
            {capabilityLabel(capability.capability, t)}
          </span>)
        : <span className="integration-management-capability is-muted">{t('managementPage.capabilitiesPending')}</span>}
    </div>

    <div className="integration-management-actions">
      {pendingAuthorization.length > 0 && item.enabled.configured && <Button
        size="small"
        disabled={saving}
        onClick={() => void authorize()}
      >{t('managementPage.authorize')}</Button>}
      {primaryAction}
      {packageState?.installed && <Button
        size="small"
        variant="danger"
        disabled={saving}
        onClick={() => {
          setRemoveMessage('')
          setError('')
          setRemoveOpen(true)
        }}
      >{t('managementPage.uninstall')}</Button>}
      <span className="integration-management-order-actions" aria-label={t('managementPage.orderAria')}>
        <IconButton
          size="small"
          aria-label={t('managementPage.moveUp', { agent: item.displayName })}
          disabled={index === 0}
          onClick={() => moveBy(item.integrationId, -1)}
        ><UiIcon name="sort-up" size={14}/></IconButton>
        <IconButton
          size="small"
          aria-label={t('managementPage.moveDown', { agent: item.displayName })}
          disabled={index === total - 1}
          onClick={() => moveBy(item.integrationId, 1)}
        ><UiIcon name="sort-down" size={14}/></IconButton>
      </span>
    </div>

    {error && <p className="integration-management-error" role="alert">{error}</p>}

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

export function IntegrationManagementPage({ model }: { model: AgentLensClientModel }) {
  const { t } = useTranslation('agents')
  const snapshot = useClientSnapshot(model)
  const management = snapshot.integrationManagement
  const { ordered } = useIntegrationOrder()

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
  const primaryItems = items.filter(isPrimaryRow)
  const supportedItems = items.filter(item => !isPrimaryRow(item))
  const detectedCount = items.filter(isDetected).length
  const installedCount = items.filter(item => item.packageState?.installed).length
  const enabledCount = items.filter(item => item.enabled.configured).length

  if (!management) {
    return <main className="workspace-page">
      <div className="page-content integration-management-content">
        <div className="empty-state roomy">{snapshot.integrationManagementError || t('managementPage.loading')}</div>
      </div>
    </main>
  }

  return <main className="workspace-page">
    <div className="page-content integration-management-content">
      <header className="integration-management-heading">
        <h1>{t('managementPage.title')}</h1>
      </header>

      <div className="integration-management-summary" aria-label={t('managementPage.summaryAria')}>
        <span><strong>{items.length}</strong>{t('managementPage.supported')}</span>
        <span><strong>{detectedCount}</strong>{t('managementPage.detected')}</span>
        <span><strong>{installedCount}</strong>{t('managementPage.added')}</span>
        <span><strong>{enabledCount}</strong>{t('managementPage.enabled')}</span>
      </div>

      <section className="integration-management-section">
        <div className="integration-management-section-head">
          <h2>{t('managementPage.localAndAdded')}</h2>
          <span>{t('managementPage.readOnlyDiscovery')}</span>
        </div>
        <div className="integration-management-list">
          {primaryItems.map(item => <IntegrationManagementRow
            key={item.integrationId}
            item={item}
            index={items.indexOf(item)}
            total={items.length}
            model={model}
            discoveryScanning={Boolean(discoveryScanning)}
            discoveryError={snapshot.integrationDiscoveryError}
          />)}
          {!primaryItems.length && <div className="integration-management-empty">{t('managementPage.noLocalOrAdded')}</div>}
        </div>
      </section>

      {supportedItems.length > 0 && <section className="integration-management-section">
        <div className="integration-management-section-head">
          <h2>{t('managementPage.otherSupported')}</h2>
          <span>{t('managementPage.otherSupportedHint')}</span>
        </div>
        <div className="integration-management-list">
          {supportedItems.map(item => <IntegrationManagementRow
            key={item.integrationId}
            item={item}
            index={items.indexOf(item)}
            total={items.length}
            model={model}
            discoveryScanning={Boolean(discoveryScanning)}
            discoveryError={snapshot.integrationDiscoveryError}
          />)}
        </div>
      </section>}
    </div>
  </main>
}
