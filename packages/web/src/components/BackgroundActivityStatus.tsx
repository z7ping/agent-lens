import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { BackgroundActivityItemDto, BackgroundActivityResponseDto } from '@agent-lens/protocol'
import { BACKGROUND_ACTIVITY_CHANGED_EVENT, fetchBackgroundActivity } from '../client/background-activity'
import { agentLabel } from './AgentScope'
import { backgroundActivityLabel, summarizeBackgroundActivity } from './background-activity-presenter'
import { Popover, StatusBadge, UiIcon, type StatusTone } from './ui'
import './background-activity-status.css'

function formatTime(value: string, locale: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function hasProblem(item: BackgroundActivityItemDto): boolean {
  return item.state === 'failed' || item.state === 'degraded'
    || Boolean(item.nativeIndex && (item.nativeIndex.failedScopes || item.nativeIndex.deferredScopes))
}

function stateTone(state: BackgroundActivityItemDto['state']): StatusTone {
  if (state === 'completed') return 'success'
  if (state === 'failed' || state === 'degraded') return 'danger'
  if (state === 'running') return 'accent'
  if (state === 'interrupted' || state === 'cancelled' || state === 'paused') return 'warning'
  return 'neutral'
}

function stateKey(state: BackgroundActivityItemDto['state']): string {
  if (state === 'cancelled') return 'backgroundActivity.stateCancelled'
  if (state === 'interrupted') return 'backgroundActivity.stateInterrupted'
  if (state === 'pending') return 'backgroundActivity.pending'
  if (state === 'running') return 'backgroundActivity.running'
  if (state === 'failed') return 'backgroundActivity.stateFailed'
  if (state === 'degraded') return 'backgroundActivity.stateDegraded'
  if (state === 'paused') return 'backgroundActivity.statePaused'
  return 'backgroundActivity.stateCompleted'
}

function elapsedSeconds(item: BackgroundActivityItemDto): number | null {
  if (!item.startedAt) return null
  const startedAt = Date.parse(item.startedAt)
  const finishedAt = item.state === 'running' ? Date.now() : Date.parse(item.completedAt ?? item.updatedAt)
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return null
  return Math.floor((finishedAt - startedAt) / 1000)
}

function recentActivities(items: BackgroundActivityItemDto[], now: number): BackgroundActivityItemDto[] {
  return items.filter(item => {
    if (hasProblem(item)) return true
    if (item.state !== 'completed') return false
    const completedAt = Date.parse(item.completedAt ?? item.updatedAt)
    return Number.isFinite(completedAt) && now >= completedAt && now - completedAt < 2 * 60_000
  })
}

export function BackgroundActivityStatus() {
  const { t, i18n } = useTranslation('common')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [activity, setActivity] = useState<BackgroundActivityResponseDto | null>(null)
  const [loadError, setLoadError] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    let controller: AbortController | undefined
    let refreshing = false
    let refreshRequested = false

    const schedule = (delay: number) => {
      if (timer !== undefined) window.clearTimeout(timer)
      if (!disposed) timer = window.setTimeout(() => { void refresh() }, delay)
    }
    const refresh = async () => {
      if (document.hidden) { schedule(30_000); return }
      if (refreshing) { refreshRequested = true; return }
      refreshing = true
      controller?.abort()
      controller = new AbortController()
      try {
        const next = await fetchBackgroundActivity(controller.signal)
        if (disposed) return
        setActivity(next)
        setLoadError('')
        schedule(open ? 5_000 : next.active.length ? 10_000 : 30_000)
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return
        setLoadError(error instanceof Error ? error.message : String(error))
        schedule(15_000)
      } finally {
        refreshing = false
        if (refreshRequested && !disposed) { refreshRequested = false; schedule(150) }
      }
    }
    const onProgress = () => {
      if (document.hidden) return
      if (refreshing) { refreshRequested = true; return }
      schedule(150)
    }
    const onVisibilityChange = () => {
      if (!document.hidden) { if (timer !== undefined) window.clearTimeout(timer); void refresh() }
    }

    schedule(open ? 0 : 2_000)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener(BACKGROUND_ACTIVITY_CHANGED_EVENT, onProgress)
    return () => {
      disposed = true
      if (timer !== undefined) window.clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener(BACKGROUND_ACTIVITY_CHANGED_EVENT, onProgress)
    }
  }, [open])

  const summary = useMemo(() => loadError
    ? { tone: 'warning' as const, label: t('backgroundActivity.statusUnavailable') }
    : summarizeBackgroundActivity(activity), [activity, loadError, t])
  const connected = activity !== null && !loadError
  const active = connected ? activity.active : []
  const recent = connected ? recentActivities(activity.recent, Date.now()) : []
  const visible = [...active, ...recent]
  const issues = visible.some(hasProblem)
  const running = active.some(item => item.state === 'running')

  return <div className="workspace-background-activity">
    <button
      ref={anchorRef}
      type="button"
      className={`background-activity-trigger is-${summary.tone}${running ? ' is-animating' : ''}`}
      aria-label={t('backgroundActivity.triggerAria', { label: summary.label })}
      aria-expanded={open}
      title={summary.label}
      onClick={() => setOpen(current => !current)}
    >
      <span className="background-activity-indicator" aria-hidden="true"/>
      <span className="background-activity-trigger-label">{summary.label}</span>
    </button>

    <Popover open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} placement="right-end" className="background-activity-popover">
      <section aria-label={t('backgroundActivity.detailAria')}>
        <header className="background-activity-popover-head">
          <b>{t('backgroundActivity.title')}</b>
          <span className={`background-activity-state is-${summary.tone}`}>
            {loadError ? t('backgroundActivity.stateDegraded') : active.length ? t('backgroundActivity.processingCount', { count: active.length }) : issues ? t('backgroundActivity.stateDegraded') : t('backgroundActivity.idleState')}
          </span>
        </header>

        <div className="background-activity-list">
          {visible.map(item => {
            const problem = hasProblem(item)
            const label = backgroundActivityLabel(item, item.sourceId ? agentLabel(item.sourceId) : undefined,
              item.state === 'running' || item.state === 'pending')
            return <div key={item.id + ':' + (item.startedAt ?? item.updatedAt)} className={`background-activity-item is-${item.state}${item.state === 'running' ? ' is-executing' : ''}`}>
              <span className="background-activity-item-mark" aria-hidden="true"/>
              <div className="background-activity-item-copy">
                <b>{label}</b>
                {item.nativeIndex && <small>{t('backgroundActivity.nativeIndexProgress', {
                  scopes: item.nativeIndex.examinedScopes, sessions: item.nativeIndex.indexedSessions,
                })}</small>}
                {problem && item.nativeIndex && <small className="background-activity-error">{t('backgroundActivity.nativeIndexIssues', {
                  failed: item.nativeIndex.failedScopes, deferred: item.nativeIndex.deferredScopes,
                })}</small>}
                {problem && !item.nativeIndex && item.errorSummary && <small className="background-activity-error">{item.errorSummary}</small>}
                <small>
                  {t('backgroundActivity.lastProgress', {
                    time: formatTime(item.completedAt ?? item.updatedAt, locale),
                  })}
                  {elapsedSeconds(item) !== null && ' · ' + t('backgroundActivity.durationSeconds', {
                    count: elapsedSeconds(item),
                  })}
                </small>
              </div>
              <StatusBadge tone={stateTone(item.state)}>{t(stateKey(item.state))}</StatusBadge>
            </div>
          })}
          {!visible.length && <div className="background-activity-empty">{t('backgroundActivity.noActive')}</div>}
        </div>
        {issues && <Link to="/agents" className="background-activity-diagnostics" onClick={() => setOpen(false)}>
          {t('backgroundActivity.openDiagnostics')}
          <UiIcon name="chevron-right" size={14}/>
        </Link>}
        {loadError && <div className="background-activity-load-error">{t('backgroundActivity.retrying', { error: loadError })}</div>}
      </section>
    </Popover>
  </div>
}
