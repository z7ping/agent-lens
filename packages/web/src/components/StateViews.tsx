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
  title,
  actions,
  onRetry,
  retryLabel,
  showDoctor = true,
}: {
  message: string
  title?: string
  actions?: ReactNode
  onRetry?: () => void
  retryLabel?: string
  showDoctor?: boolean
}) {
  const { t } = useTranslation('common')
  const resolvedRetryLabel = retryLabel ?? t('retry')
  return <div className="state-error" role="alert">
    <div className="state-error-copy"><b>{title ?? t('loadFailed')}</b><span>{message}</span></div>
    <div className="state-error-actions">
      {actions}
      {onRetry && <Button variant="primary" onClick={onRetry}>{resolvedRetryLabel}</Button>}
      {showDoctor && <CommandRow command="agent-lens doctor"/>}
    </div>
  </div>
}

function SkeletonLine({ width = '100%', height = 11 }: { width?: string; height?: number }) {
  return <span className="state-skeleton" style={{ width, height }}/>
}

/** Match the actual Task Center rail: a day heading and compact, borderless session rows. */
export function SessionListSkeleton() {
  const { t } = useTranslation('common')
  return <div className="session-list-skeleton" role="status" aria-label={t('loadingSessions')}>
    <div aria-hidden="true">
      <div className="session-skeleton-group"><SkeletonLine width="42px"/></div>
      {[0, 1, 2, 3].map(index => <div className="session-skeleton-row" key={index}>
        <SkeletonLine width={index % 2 ? '68%' : '85%'} height={14}/>
        <div className="state-skeleton-row">
          <span className="state-skeleton state-skeleton-dot"/>
          <SkeletonLine width={index % 2 ? '76px' : '64px'}/>
          <SkeletonLine width="52px"/>
        </div>
      </div>)}
    </div>
  </div>
}

/** One shared loading shape for the flat Live / Review reading surface. */
export function ReviewDetailSkeleton() {
  const { t } = useTranslation('common')
  return <div className="review-detail-skeleton" role="status" aria-label={t('loadingSessionDetail')}>
    <div aria-hidden="true">
      <div className="review-detail-skeleton-header">
        <SkeletonLine width="44%" height={17}/>
        <div className="state-skeleton-row"><SkeletonLine width="82px"/><SkeletonLine width="56px"/></div>
      </div>
      <div className="review-detail-skeleton-body">
        <div className="review-detail-skeleton-user"><SkeletonLine width="72%" height={13}/><SkeletonLine width="48%"/></div>
        <div className="review-detail-skeleton-answer">
          <SkeletonLine width="88%" height={13}/><SkeletonLine width="96%" height={13}/><SkeletonLine width="64%"/>
        </div>
        <div className="review-detail-skeleton-process"><SkeletonLine width="36%"/><SkeletonLine width="78%"/></div>
      </div>
    </div>
  </div>
}

export type WorkspaceSkeletonKind = 'agents' | 'insights' | 'tools'

/** Page-aware variants share one primitive rather than inventing page-local loaders. */
export function WorkspaceSkeleton({ kind = 'agents' }: { kind?: WorkspaceSkeletonKind }) {
  const { t } = useTranslation('common')
  return <div className={`workspace-skeleton is-${kind}`} role="status" aria-label={t('loadingPageData')}>
    <div aria-hidden="true">
      {kind === 'agents' ? <>
        <div className="workspace-skeleton-heading"><SkeletonLine width="160px" height={18}/><SkeletonLine width="80px"/></div>
        <div className="workspace-skeleton-agent-info">
          <div className="state-skeleton-row"><SkeletonLine width="44px" height={36}/><SkeletonLine width="42%" height={18}/></div>
          <div className="workspace-skeleton-agent-properties">
            {[0, 1, 2].map(i => <div className="state-skeleton-row" key={i}><SkeletonLine width="68px"/><SkeletonLine width={i === 1 ? '52%' : '34%'}/></div>)}
          </div>
        </div>
        <div className="workspace-skeleton-agent-sections">
          <div><SkeletonLine width="100px" height={14}/><SkeletonLine width="82%"/><SkeletonLine width="64%"/></div>
          <div><SkeletonLine width="92px" height={14}/><SkeletonLine width="72%"/><SkeletonLine width="58%"/></div>
        </div>
      </> : <>
        {kind === 'insights' && <div className="workspace-skeleton-coverage">
          {[0, 1, 2, 3].map(i => <div key={i}><SkeletonLine width="62px"/><SkeletonLine width={i % 2 ? '70%' : '55%'} height={14}/></div>)}
        </div>}
        <div className="workspace-skeleton-metrics">
          {[0, 1, 2, 3].map(index => <div key={index}>
            <SkeletonLine width="66px"/>
            <SkeletonLine width={index === 0 ? '58%' : '44%'} height={22}/>
            <SkeletonLine width="72px"/>
          </div>)}
        </div>
        {kind === 'insights' && <div className="workspace-skeleton-chart-panels">
          <div><SkeletonLine width="120px" height={14}/><span className="state-skeleton workspace-skeleton-chart"/></div>
          <div><SkeletonLine width="100px" height={14}/>{[0, 1, 2].map(i => <SkeletonLine key={i} width={i === 1 ? '65%' : '84%'}/>)}</div>
        </div>}
        <div className="workspace-skeleton-table">
          <SkeletonLine width={kind === 'tools' ? '86px' : '110px'} height={14}/>
          <div className="workspace-skeleton-table-head"><SkeletonLine width="42%"/><SkeletonLine width="36%"/></div>
          {[0, 1, 2, 3].map(i => <div className="workspace-skeleton-table-row" key={i}>
            <SkeletonLine width={i % 2 ? '52%' : '68%'}/><SkeletonLine width="28%"/>
          </div>)}
        </div>
      </>}
    </div>
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
  return <div className="page-loading-state" role="status" aria-live="polite" aria-label={title}>
    <div className="page-loading-card">
      <UiIcon name="refresh" size={20}/>
      <div className="page-loading-copy">
        <div className="page-loading-kicker">{eyebrow ?? t('processing')} · {statusLabel ?? t('inProgress')}</div>
        <h2>{title}</h2>
        <p>{description}</p>
        {facts.length > 0 && <p className="page-loading-facts">{facts.join(' · ')}</p>}
      </div>
    </div>
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
    <div className="first-run-heading"><span className="eyebrow">{t('firstRun.eyebrow')}</span><h2>{t('firstRun.title')}</h2></div>
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
