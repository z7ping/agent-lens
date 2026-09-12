import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IntegrationManagementItemDto } from '@agent-lens/protocol'
import type { AgentLensClientModel, ClientSnapshot } from '../client/model'
import { Button, StatusBadge } from '../components/ui'
import { integrationPackageReady } from './integrations/integration-lifecycle'

type InstallStep = 'idle' | 'installing' | 'enabling' | 'done' | 'failed' | 'skipped'

interface InstallProgress {
  step: InstallStep
  message?: string
}

function selectable(item: IntegrationManagementItemDto): boolean {
  return item.tool?.presence === 'present' || item.tool?.presence === 'data-only'
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
  const missing = useMemo(() => items.filter(item => !selectable(item)), [items])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [progress, setProgress] = useState<Record<string, InstallProgress>>({})
  const [running, setRunning] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [error, setError] = useState('')

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

  const runOne = async (item: IntegrationManagementItemDto) => {
    const id = item.integrationId
    try {
      if (!integrationPackageReady(item.packageState)) {
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
      await model.setIntegrationEnabled(id, true)
      setProgress(current => ({ ...current, [id]: { step: 'done' } }))
      return true
    } catch (cause) {
      setProgress(current => ({
        ...current,
        [id]: {
          step: 'failed',
          message: cause instanceof Error ? cause.message : String(cause),
        },
      }))
      return false
    }
  }

  const begin = async () => {
    const chosen = detected.filter(item => selected.has(item.integrationId))
    if (!chosen.length || running || finishing) return
    setRunning(true)
    setError('')
    let allSucceeded = true
    for (const item of chosen) {
      if (!await runOne(item)) allSucceeded = false
    }
    setRunning(false)
    if (allSucceeded) await finish()
  }

  const retry = async (item: IntegrationManagementItemDto) => {
    if (running || finishing) return
    setRunning(true)
    const succeeded = await runOne(item)
    setRunning(false)
    if (!succeeded) return
    const unresolved = [...selected].some(id => {
      if (id === item.integrationId) return false
      const step = progress[id]?.step
      return step === 'failed' || step === 'installing' || step === 'enabling' || step === 'idle' || !step
    })
    if (!unresolved) await finish()
  }

  const skip = async (integrationId: string) => {
    const next = { ...progress, [integrationId]: { step: 'skipped' as const } }
    setProgress(next)
    const unresolved = [...selected].some(id => {
      const step = next[id]?.step
      return step !== 'done' && step !== 'skipped'
    })
    if (!unresolved) await finish()
  }

  const toggle = (integrationId: string) => {
    if (running || finishing) return
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
          <p>{t('onboarding.description')}</p>
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
          const busy = state.step === 'installing' || state.step === 'enabling'
          return <div key={item.integrationId} className={`integration-onboarding-item ${checked ? 'is-selected' : ''}`}>
            <label>
              <input
                type="checkbox"
                checked={checked}
                disabled={running || finishing || state.step === 'done'}
                onChange={() => toggle(item.integrationId)}
              />
              <span className="integration-onboarding-copy">
                <b>{item.displayName}</b>
                <small>
                  {item.tool?.presence === 'data-only'
                    ? t('onboarding.historyData')
                    : t('onboarding.discovered')}
                </small>
                {(item.tool?.executable || item.tool?.configRoot || item.tool?.dataRoot) && <code>
                  {item.tool?.executable ?? item.tool?.configRoot ?? item.tool?.dataRoot}
                </code>}
              </span>
            </label>
            <div className="integration-onboarding-state">
              {state.step === 'installing' && <StatusBadge tone="accent" dot>{t('onboarding.installing')}</StatusBadge>}
              {state.step === 'enabling' && <StatusBadge tone="accent" dot>{t('onboarding.enabling')}</StatusBadge>}
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
        <b>{t('onboarding.noneFound')}</b>
        <span>{t('onboarding.noneFoundDescription')}</span>
      </div>}

      {!scanning && missing.length > 0 && <p className="integration-onboarding-missing">
        {t('onboarding.notFound', { agents: missing.map(item => item.displayName).join('、') })}
      </p>}

      {error && <p className="integration-onboarding-error" role="alert">{error}</p>}

      <footer className="integration-onboarding-footer">
        <span>{t('onboarding.selectedCount', { count: selected.size })}</span>
        <div>
          <Button disabled={running || finishing} onClick={() => void finish()}>{t('onboarding.later')}</Button>
          <Button
            variant="primary"
            loading={running || finishing}
            disabled={scanning || selected.size === 0}
            onClick={() => void begin()}
          >{t('onboarding.start')}</Button>
        </div>
      </footer>
    </section>
  </main>
}

export const integrationOnboardingInternals = {
  selectable,
  acknowledgedAfterOnboarding,
}
