import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentLogo } from '../components/AgentLogo'
import type { IntegrationManagementItemDto } from '@agent-lens/protocol'
import type { AgentLensClientModel, ClientSnapshot } from '../client/model'
import { Button, Dialog, StatusBadge } from '../components/ui'
import { integrationAuthorizationSummary, integrationPackageReady } from './integrations/integration-lifecycle'

type InstallStep = 'idle' | 'installing' | 'enabling' | 'authorizing' | 'done' | 'failed' | 'skipped'

interface InstallProgress {
  step: InstallStep
  message?: string
}

function selectable(item: IntegrationManagementItemDto): boolean {
  return item.tool?.presence === 'present' || item.tool?.presence === 'data-only'
}

function hasProtectedCapabilities(item: IntegrationManagementItemDto): boolean {
  return item.capabilities.some(capability =>
    capability.capability === 'live' || capability.capability === 'hook' || capability.capability === 'runtime'
  )
}

function acknowledgedAfterOnboarding(snapshot: ClientSnapshot): string[] {
  const current = snapshot.integrationManagement?.preferences.acknowledgedIntegrationIds ?? []
  const discovered = snapshot.integrationManagement?.items
    .filter(selectable)
    .map(item => item.integrationId) ?? []
  return [...new Set([...current, ...discovered])]
}

export function IntegrationOnboarding({
  model,
  snapshot,
}: {
  model: AgentLensClientModel
  snapshot: ClientSnapshot
}) {
  const { t } = useTranslation('agents')
  const management = snapshot.integrationManagement
  const items = management?.items ?? []
  const detected = useMemo(() => items.filter(selectable), [items])
  const failed = useMemo(() => items.filter(item => item.tool?.presence === 'error'), [items])
  const missing = useMemo(() => items.filter(item => item.tool?.presence === 'absent'), [items])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({})
  const [running, setRunning] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [error, setError] = useState('')
  const [grantLive, setGrantLive] = useState(true)
  const [confirmedGrantLive, setConfirmedGrantLive] = useState(true)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)
  const [readyToFinish, setReadyToFinish] = useState(false)
  const chosen = detected.filter(item => selected.has(item.integrationId))
  const hasLiveOptions = chosen.some(hasProtectedCapabilities)
  const unknownAuthorization = grantLive && chosen.some(item =>
    hasProtectedCapabilities(item) && integrationAuthorizationSummary(item.capabilities).phase === 'unknown'
  )

  const scanning = management?.discovery.status === 'idle'
    || management?.discovery.status === 'scanning'
    || snapshot.integrationDiscoveryLoading
    || snapshot.integrationDiscoveryRescanning

  const finish = async () => {
    setFinishing(true)
    setError('')
    try {
      await model.updateIntegrationPreferences({
        onboardingCompleted: true,
        acknowledgedIntegrationIds: acknowledgedAfterOnboarding(snapshot),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setFinishing(false)
    }
  }

  const runOne = async (item: IntegrationManagementItemDto, withLive: boolean) => {
    const id = item.integrationId
    let needsRestart = item.enabled.restartRequired
    try {
      // The slim runtime may not expose a separately managed Integration package.
      if (item.packageState && !integrationPackageReady(item.packageState)) {
        setProgress(current => ({ ...current, [id]: { step: 'installing' } }))
        const installed = await model.installIntegration(id)
        if (
          installed.operation.status !== 'completed'
          || !integrationPackageReady(installed.state)
        ) {
          throw new Error(installed.operation.message || installed.state.reason || t('onboarding.failedDetail'))
        }
      }
      setProgress(current => ({ ...current, [id]: { step: 'enabling' } }))
      if (!item.enabled.configured) {
        const result = await model.setIntegrationEnabled(id, true)
        needsRestart = needsRestart || result.enabled.restartRequired
      }

      const authorization = integrationAuthorizationSummary(item.capabilities)
      if (withLive && hasProtectedCapabilities(item) && authorization.phase === 'unknown') {
        throw new Error(t('onboarding.permissionUnknown'))
      }
      needsRestart = needsRestart || (withLive && authorization.phase === 'restart-required')
      if (withLive && authorization.pending.length) {
        setProgress(current => ({ ...current, [id]: { step: 'authorizing' } }))
        // Only the capabilities explicitly confirmed in the dialog may be granted.
        const result = await model.authorizeIntegration(item.productId, authorization.pending)
        if (!authorization.pending.every(capability => result.authorizedCapabilities.includes(capability))) {
          throw new Error(t('onboarding.authorizationIncomplete'))
        }
        needsRestart = needsRestart || result.restartRequired
      }
      setProgress(current => ({ ...current, [id]: { step: 'done' } }))
      return { succeeded: true, needsRestart }
    } catch (cause) {
      setProgress(current => ({
        ...current,
        [id]: {
          step: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
        },
      }))
      return { succeeded: false, needsRestart }
    }
  }

  const begin = () => {
    const chosen = detected.filter(item => selected.has(item.integrationId))
    if (!chosen.length || running || finishing || readyToFinish) return
    setConfirmOpen(true)
  }

  const confirm = async () => {
    if (!chosen.length || running || finishing || unknownAuthorization) return
    setConfirmOpen(false)
    setConfirmedGrantLive(grantLive)
    setRunning(true)
    setError('')
    let allSucceeded = true
    let anyRestartRequired = false
    for (const item of chosen) {
      const result = await runOne(item, grantLive)
      if (!result.succeeded) allSucceeded = false
      if (result.needsRestart) anyRestartRequired = true
    }
    setRunning(false)
    setRestartRequired(anyRestartRequired)
    if (allSucceeded) {
      if (anyRestartRequired) setReadyToFinish(true)
      else await finish()
    }
  }

  const retry = async (item: IntegrationManagementItemDto) => {
    if (running || finishing) return
    setRunning(true)
    const result = await runOne(item, confirmedGrantLive)
    setRunning(false)
    const pendingRestart = restartRequired || result.needsRestart
    setRestartRequired(pendingRestart)
    if (!result.succeeded) return
    const unresolved = [...selected].some(id => {
      if (id === item.integrationId) return false
      const step = progress[id]?.step
      return step === 'failed' || step === 'installing' || step === 'enabling' || step === 'authorizing' || step === 'idle' || !step
    })
    if (!unresolved) {
      if (pendingRestart) setReadyToFinish(true)
      else await finish()
    }
  }

  const skip = async (integrationId: string) => {
    const next = { ...progress, [integrationId]: { step: 'skipped' as const } }
    setProgress(next)
    const unresolved = [...selected].some(id => {
      const step = next[id]?.step
      return step !== 'done' && step !== 'skipped'
    })
    if (!unresolved) {
      if (restartRequired) setReadyToFinish(true)
      else await finish()
    }
  }

  const toggle = (integrationId: string) => {
    if (running || finishing || readyToFinish) return
    setSelected(current => {
      const next = new Set(current)
      if (next.has(integrationId)) next.delete(integrationId)
      else next.add(integrationId)
      return next
    })
  }

  return <main className="integration-onboarding-shell">
    <section className="integration-onboarding-panel" aria-labelledby="integration-onboarding-title">
      <header className="integration-onboarding-header">
        <div>
          <h1 id="integration-onboarding-title">{t('onboarding.title')}</h1>
        </div>
        <div className="integration-onboarding-scan-actions">
          <StatusBadge tone={scanning ? 'accent' : 'success'} dot>
            {scanning ? t('onboarding.scanning') : t('onboarding.scanComplete')}
          </StatusBadge>
          <Button
            size="small"
            loading={snapshot.integrationDiscoveryRescanning}
            disabled={scanning && !snapshot.integrationDiscoveryRescanning}
            onClick={() => void model.rescanIntegrationDiscovery().catch(() => undefined)}
          >{t('onboarding.rescan')}</Button>
        </div>
      </header>

      <div className="integration-onboarding-list">
        {detected.map(item => {
          const state = progress[item.integrationId] ?? { step: 'idle' as const }
          const checked = selected.has(item.integrationId)
          const authorization = integrationAuthorizationSummary(item.capabilities)
          const busy = state.step === 'installing' || state.step === 'enabling' || state.step === 'authorizing'
          return <div key={item.integrationId} className={`integration-onboarding-item ${checked ? 'is-selected' : ''}`}>
            <label>
              <input
                type="checkbox"
                checked={checked}
                disabled={running || finishing || readyToFinish || state.step === 'done'}
                onChange={() => toggle(item.integrationId)}
              />
              <AgentLogo sourceId={item.integrationId} size="normal"/>
              <span className="integration-onboarding-copy">
                <b>{item.displayName}</b>
                <small>
                  {item.tool?.presence === 'data-only'
                    ? t('onboarding.historyData')
                    : t('onboarding.discovered')}
                </small>
                {checked && <small className="integration-onboarding-permission-state">
                  {authorization.phase === 'required'
                    ? t(grantLive ? 'onboarding.permissionPending' : 'onboarding.historyOnly')
                    : authorization.phase === 'granted'
                      ? t('onboarding.permissionGranted')
                      : authorization.phase === 'restart-required'
                        ? t('onboarding.permissionRestart')
                        : authorization.phase === 'unknown'
                          ? t('onboarding.permissionUnknownShort')
                          : t('onboarding.historyOnly')}
                </small>}
                {(item.tool?.executable || item.tool?.configRoot || item.tool?.dataRoot) && <code>
                  {item.tool?.executable ?? item.tool?.configRoot ?? item.tool?.dataRoot}
                </code>}
              </span>
            </label>
            <div className="integration-onboarding-state">
              {state.step === 'installing' && <StatusBadge tone="accent" dot>{t('onboarding.installing')}</StatusBadge>}
              {state.step === 'enabling' && <StatusBadge tone="accent" dot>{t('onboarding.enabling')}</StatusBadge>}
              {state.step === 'authorizing' && <StatusBadge tone="accent" dot>{t('onboarding.authorizing')}</StatusBadge>}
              {state.step === 'done' && <StatusBadge tone="success" dot>{t('onboarding.installed')}</StatusBadge>}
              {state.step === 'skipped' && <StatusBadge>{t('onboarding.skipped')}</StatusBadge>}
              {state.step === 'failed' && <>
                <StatusBadge tone="danger" title={state.message}>{t('onboarding.failed')}</StatusBadge>
                <Button size="small" disabled={running || finishing} onClick={() => void retry(item)}>{t('onboarding.retry')}</Button>
                <Button size="small" disabled={running || finishing} onClick={() => void skip(item.integrationId)}>{t('onboarding.skip')}</Button>
              </>}
              {busy && <span className="integration-onboarding-busy" aria-hidden="true"/>}
            </div>
          </div>
        })}
      </div>

      {!detected.length && !scanning && <div className="integration-onboarding-empty">
        <b>{failed.length ? t('onboarding.noneConfirmed') : t('onboarding.noneFound')}</b>
        <span>{failed.length ? t('onboarding.noneConfirmedDescription') : t('onboarding.noneFoundDescription')}</span>
      </div>}

      {!scanning && failed.length > 0 && <p className="integration-onboarding-missing">
        {t('onboarding.scanFailedAgents', { agents: failed.map(item => item.displayName).join('、') })}
      </p>}

      {!scanning && missing.length > 0 && <p className="integration-onboarding-missing">
        {t('onboarding.notFound', { agents: missing.map(item => item.displayName).join('、') })}
      </p>}

      {hasLiveOptions && <label className="integration-onboarding-access-option">
        <input type="checkbox" checked={grantLive} disabled={running || finishing || readyToFinish}
          onChange={event => setGrantLive(event.target.checked)}/>
        <span><b>{t('onboarding.enableLive')}</b><small>{t('onboarding.enableLiveDescription')}</small></span>
      </label>}

      {readyToFinish && restartRequired && <p className="integration-onboarding-restart" role="status">
        {t('onboarding.restartRequired')}
      </p>}
      {error && <p className="integration-onboarding-error" role="alert">{error}</p>}

      <footer className="integration-onboarding-footer">
        <span>{t('onboarding.selectedCount', { count: selected.size })}</span>
        <div>
          {!readyToFinish && <Button disabled={running || finishing} onClick={() => void finish()}>{t('onboarding.later')}</Button>}
          <Button
            variant="primary"
            loading={running || finishing}
            disabled={!readyToFinish && (scanning || selected.size === 0)}
            onClick={() => readyToFinish ? void finish() : begin()}
          >{t(readyToFinish ? 'onboarding.finish' : 'onboarding.start')}</Button>
        </div>
      </footer>
    </section>
    <Dialog
      open={confirmOpen}
      onClose={() => setConfirmOpen(false)}
      title={t('onboarding.confirmTitle')}
      description={t('onboarding.confirmDescription')}
      footer={<>
        <Button disabled={running} onClick={() => setConfirmOpen(false)}>{t('onboarding.cancel')}</Button>
        <Button variant="primary" disabled={running || unknownAuthorization}
          onClick={() => void confirm()}>{t('onboarding.confirm')}</Button>
      </>}
    >
      <div className="integration-onboarding-consent-list">
        {chosen.map(item => {
          const authorization = integrationAuthorizationSummary(item.capabilities)
          const requested = grantLive ? authorization.pending : []
          return <div key={item.integrationId} className="integration-onboarding-consent-item">
            <b>{item.displayName}</b>
            <span>{t('onboarding.historyAccess')}</span>
            {requested.length > 0 && <span>{t('onboarding.controlAccess', {
              capabilities: requested.map(capability =>
                t(`integrationCapability.${capability}`)
              ).join(' / '),
            })}</span>}
            {authorization.phase === 'granted' && <span>{t('onboarding.permissionGranted')}</span>}
            {grantLive && authorization.phase === 'restart-required' && <span>{t('onboarding.permissionRestart')}</span>}
          </div>
        })}
      </div>
      {unknownAuthorization && <p className="integration-onboarding-error" role="alert">{t('onboarding.permissionUnknown')}</p>}
      {grantLive && <p className="integration-onboarding-consent-note">{t('onboarding.restartNotice')}</p>}
    </Dialog>
  </main>
}

export const integrationOnboardingInternals = {
  selectable,
  acknowledgedAfterOnboarding,
}
