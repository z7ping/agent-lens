import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { copyText } from '../client/clipboard'
import { UiIcon } from './UiIcon'
import { Button } from './ui'

export function CommandRow({ command }: { command: string }) {
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await copyText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }
  return <span className="state-command"><code>{command}</code><button onClick={() => void copy()}>{copied ? t('copied') : t('copy')}</button></span>
}

export function EmptyStatePanel({
  icon,
  title,
  description,
  action,
  children,
  compact = false,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: { label: string; onClick(): void }
  children?: ReactNode
  compact?: boolean
}) {
  return <div className={`state-empty ${compact ? 'is-compact' : ''}`}>
    <div className="state-empty-icon" aria-hidden="true">{icon}</div>
    <h3>{title}</h3>
    <p>{description}</p>
    {(action || children) && <div className="state-actions">
      {action && <Button variant="primary" onClick={action.onClick}>{action.label}</Button>}
      {children}
    </div>}
  </div>
}

export function ErrorStateBanner({
  message,
  onRetry,
  retryLabel,
  showDoctor = true,
}: {
  message: string
  onRetry?: () => void
  retryLabel?: string
  showDoctor?: boolean
}) {
  const { t } = useTranslation('common')
  const resolvedRetryLabel = retryLabel ?? t('retry')
  return <div className="state-error" role="alert">
    <div className="state-error-copy"><b>{t('loadFailed')}</b><span>{message}</span></div>
    <div className="state-error-actions">
      {onRetry && <Button variant="primary" onClick={onRetry}>{resolvedRetryLabel}</Button>}
      {showDoctor && <CommandRow command="agent-lens doctor"/>}
    </div>
  </div>
}

function SkeletonLine({ width = '100%', height = 11 }: { width?: string; height?: number }) {
  return <span className="state-skeleton" style={{ width, height }}/>
}

export function SessionListSkeleton() {
  const { t } = useTranslation('common')
  return <div className="session-list-skeleton" aria-label={t('loadingSessions')}>
    {[0, 1, 2, 3].map(index => <div className="session-skeleton-card" key={index}>
      <div className="state-skeleton-row"><span className="state-skeleton state-skeleton-dot"/><SkeletonLine width={index % 2 ? '66px' : '58px'}/><SkeletonLine width="48px"/></div>
      <SkeletonLine width={index % 2 ? '76%' : '84%'} height={13}/>
      <SkeletonLine width={index % 2 ? '52%' : '61%'}/>
    </div>)}
  </div>
}

export function ReviewDetailSkeleton() {
  const { t } = useTranslation('common')
  return <div className="review-detail-skeleton" aria-label={t('loadingSessionDetail')}>
    <SkeletonLine width="42%" height={19}/>
    <SkeletonLine width="30%"/>
    <div className="review-detail-skeleton-metrics">
      {[0, 1, 2, 3].map(index => <span className="state-skeleton" key={index}/>) }
    </div>
    <span className="state-skeleton review-detail-skeleton-message"/>
    <span className="state-skeleton review-detail-skeleton-flow"/>
    <span className="state-skeleton review-detail-skeleton-message short"/>
  </div>
}

export function WorkspaceSkeleton({ kind = 'cards' }: { kind?: 'cards' | 'table' }) {
  const { t } = useTranslation('common')
  return <div className={`workspace-skeleton workspace-skeleton-${kind}`} aria-label={t('loadingPageData')}>
    <SkeletonLine width="112px" height={20}/>
    <SkeletonLine width="48%"/>
    {kind === 'table' ? <>
      <div className="workspace-skeleton-kpis">{[0, 1, 2, 3].map(index => <span key={index} className="state-skeleton"/>)}</div>
      <div className="workspace-skeleton-table">
        {[0, 1, 2, 3, 4].map(index => <span key={index} className="state-skeleton"/>) }
      </div>
    </> : <div className="workspace-skeleton-cards">{[0, 1].map(index => <span key={index} className="state-skeleton"/>)}</div>}
  </div>
}

export function PageLoadingState({
  eyebrow,
  statusLabel,
  title,
  description,
  facts = [],
}: {
  eyebrow?: string
  statusLabel?: string
  title: string
  description: string
  facts?: string[]
}) {
  const { t } = useTranslation('common')
  const resolvedEyebrow = eyebrow ?? t('processing')
  const resolvedStatusLabel = statusLabel ?? t('inProgress')
  return <div className="page-loading-state" role="status" aria-live="polite" aria-label={title}>
    <section className="page-loading-card">
      <div className="page-loading-main">
        <div className="page-loading-icon" aria-hidden="true"><UiIcon name="refresh" size={20}/></div>
        <div className="page-loading-copy">
          <div className="page-loading-kicker">
            <span className="eyebrow">{resolvedEyebrow}</span>
            <span className="page-loading-badge"><i/>{resolvedStatusLabel}</span>
          </div>
          <h2>{title}</h2>
          <p>{description}</p>
          {facts.length > 0 && <div className="page-loading-facts">
            {facts.map(fact => <span key={fact}><UiIcon name="check" size={12}/>{fact}</span>)}
          </div>}
        </div>
      </div>
      <div className="page-loading-progress" aria-hidden="true"><i/></div>
      <div className="page-loading-preview" aria-hidden="true">
        {[0, 1, 2].map(index => <div className="page-loading-preview-card" key={index}>
          <SkeletonLine width={index === 0 ? '42%' : index === 1 ? '34%' : '38%'}/>
          <SkeletonLine width={index === 0 ? '64%' : index === 1 ? '52%' : '58%'} height={21}/>
          <SkeletonLine width={index === 0 ? '76%' : index === 1 ? '68%' : '72%'}/>
        </div>)}
      </div>
    </section>
  </div>
}

export function OperationProgress({
  title,
  description,
  statusLabel,
  elapsedMs,
  tone = 'accent',
  active = true,
  children,
}: {
  title: string
  description: string
  statusLabel?: string
  elapsedMs?: number
  tone?: 'accent' | 'danger'
  active?: boolean
  children?: ReactNode
}) {
  const { t } = useTranslation('common')
  const resolvedStatusLabel = statusLabel ?? t('inProgress')
  const elapsed = elapsedMs === undefined
    ? ''
    : elapsedMs < 1_000
      ? '<1s'
      : `${Math.floor(elapsedMs / 60_000) > 0 ? `${Math.floor(elapsedMs / 60_000)}m ` : ''}${Math.floor((elapsedMs % 60_000) / 1_000)}s`
  return <section className={`operation-progress is-${tone} ${active ? 'is-active' : ''}`} role={tone === 'danger' ? 'alert' : 'status'} aria-live="polite" aria-label={title}>
    <div className="operation-progress-main">
      <span className="operation-progress-icon" aria-hidden="true"><UiIcon name={tone === 'danger' ? 'exclamation' : 'refresh'} size={20}/></span>
      <span className="operation-progress-copy">
        <span className="operation-progress-kicker"><b>{resolvedStatusLabel}</b>{elapsed && <small>{elapsed}</small>}</span>
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
    </div>
    {active && <span className="operation-progress-track" aria-hidden="true"><i/></span>}
    {children && <div className="operation-progress-body">{children}</div>}
  </section>
}

export function FirstRunGuide({
  detectedCount,
  enabledCount,
  serviceReady,
  liveConnected,
}: {
  detectedCount: number
  enabledCount: number
  serviceReady: boolean
  liveConnected: boolean
}) {
  const { t } = useTranslation('common')
  const captureReady = enabledCount > 0 && serviceReady && liveConnected
  const captureDescription = enabledCount > 0
    ? serviceReady
      ? liveConnected
        ? t('firstRun.captureReady', { count: enabledCount })
        : t('firstRun.captureNoLive', { count: enabledCount })
      : t('firstRun.captureServiceUnavailable', { count: enabledCount })
    : t('firstRun.captureDisabled')
  return <section className="first-run-guide" aria-label={t('firstRun.aria')}>
    <div className="first-run-heading"><span className="eyebrow">{t('firstRun.eyebrow')}</span><h2>{t('firstRun.title')}</h2><p>{t('firstRun.description')}</p></div>
    <div className="first-run-steps">
      <div className={`first-run-step ${detectedCount > 0 ? 'is-done' : 'is-pending'}`}>
        <span className="first-run-no">{detectedCount > 0 ? <UiIcon name="check" size={14}/> : '1'}</span>
        <div><b>{t('firstRun.detectTitle')}</b><p>{detectedCount > 0 ? t('firstRun.detected', { count: detectedCount }) : t('firstRun.noneDetected')}</p></div>
      </div>
      <div className={`first-run-step ${captureReady ? 'is-done' : 'is-pending'}`}>
        <span className="first-run-no">{captureReady ? <UiIcon name="check" size={14}/> : '2'}</span>
        <div><b>{t('firstRun.captureTitle')}</b><p>{captureDescription}</p></div>
      </div>
      <div className="first-run-step is-pending">
        <span className="first-run-no">3</span>
        <div><b>{t('firstRun.sessionTitle')}</b><p>{t('firstRun.sessionDescription')}</p></div>
      </div>
    </div>
    {(!detectedCount || !captureReady) && <div className="first-run-footer"><span>{t('firstRun.doctorHint')}</span><CommandRow command="agent-lens doctor"/></div>}
  </section>
}
