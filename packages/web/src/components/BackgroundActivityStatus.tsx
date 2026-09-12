import { useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { BackgroundActivityItemDto, BackgroundActivityResponseDto, HealthResponseDto } from '@agent-lens/protocol'
import { fetchBackgroundActivity } from '../client/background-activity'
import { agentLabel } from './AgentScope'
import { backgroundActivityLabel, summarizeBackgroundActivity } from './background-activity-presenter'
import { Popover } from './ui'
import './background-activity-status.css'

function formatTime(value: string, locale: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

function runtimeOwnerLabel(owner: NonNullable<HealthResponseDto['runtime']>['owner'], t: TFunction): string {
  if (owner === 'desktop') return t('backgroundActivity.ownerDesktop')
  if (owner === 'service') return t('backgroundActivity.ownerService')
  if (owner === 'cli') return t('backgroundActivity.ownerCli')
  return t('backgroundActivity.ownerRuntime')
}

function itemLabel(item: BackgroundActivityItemDto, active: boolean): string {
  return backgroundActivityLabel(item, item.sourceId ? agentLabel(item.sourceId) : undefined, active)
}

function recentStateLabel(item: BackgroundActivityItemDto, t: TFunction): string {
  if (item.state === 'failed') return t('backgroundActivity.stateFailed')
  if (item.state === 'degraded') return t('backgroundActivity.stateDegraded')
  if (item.state === 'paused') return t('backgroundActivity.statePaused')
  return t('backgroundActivity.stateCompleted')
}

export function BackgroundActivityStatus({ health }: { health: HealthResponseDto | null }) {
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

    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
    }
    const schedule = (delay: number) => {
      clearTimer()
      if (!disposed) timer = window.setTimeout(() => { void refresh() }, delay)
    }
    const refresh = async () => {
      if (document.hidden) {
        schedule(10_000)
        return
      }
      controller?.abort()
      controller = new AbortController()
      try {
        const next = await fetchBackgroundActivity(controller.signal)
        if (disposed) return
        setActivity(next)
        setLoadError('')
        schedule(next.active.length ? 2_500 : 8_000)
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === 'AbortError')) return
        setLoadError(error instanceof Error ? error.message : String(error))
        schedule(15_000)
      }
    }
    const onVisibilityChange = () => {
      if (document.hidden) return
      clearTimer()
      void refresh()
    }

    void refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      clearTimer()
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const summary = useMemo(() => {
    const base = summarizeBackgroundActivity(activity)
    const primary = activity?.active[0]
    if (!primary) return base
    const suffix = activity!.active.length > 1 ? t('backgroundActivity.moreActive', { count: activity!.active.length - 1 }) : ''
    return { ...base, label: `${itemLabel(primary, true)}${suffix}` }
  }, [activity, t])

  const runtimeText = health?.runtime
    ? t('backgroundActivity.runtimeProcess', { owner: runtimeOwnerLabel(health.runtime.owner, t), pid: health.runtime.pid })
    : t('backgroundActivity.runtimeUnavailable')
  const runtimeTone = health?.status === 'ok' ? 'ok' : health ? 'degraded' : 'unknown'

  return <div className="workspace-background-activity">
    <button
      ref={anchorRef}
      type="button"
      className={`background-activity-trigger is-${summary.tone}`}
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
          <div><b>{t('backgroundActivity.title')}</b><span>{t('backgroundActivity.description')}</span></div>
          <span className={`background-activity-state is-${summary.tone}`}>{activity?.active.length ? t('backgroundActivity.processingCount', { count: activity.active.length }) : t('backgroundActivity.recentRecord')}</span>
        </header>

        <div className={`background-activity-process is-${runtimeTone}`}><span className="background-activity-process-dot" aria-hidden="true"/><span>{runtimeText}</span></div>

        <div className="background-activity-section">
          <div className="background-activity-section-title">{t('backgroundActivity.processing')}</div>
          {activity?.active.length
            ? <div className="background-activity-list">{activity.active.map(item => <div key={item.id} className="background-activity-item is-active">
                <span className="background-activity-item-mark" aria-hidden="true"/>
                <span className="background-activity-item-copy"><b>{itemLabel(item, true)}</b><small>{item.startedAt ? t('backgroundActivity.startedAt', { time: formatTime(item.startedAt, locale) }) : item.state === 'pending' ? t('backgroundActivity.pending') : t('backgroundActivity.running')}</small></span>
              </div>)}</div>
            : <div className="background-activity-empty">{t('backgroundActivity.noActive')}</div>}
        </div>

        <div className="background-activity-section">
          <div className="background-activity-section-title">{t('backgroundActivity.recent')}</div>
          {activity?.recent.length
            ? <div className="background-activity-list">{activity.recent.map(item => <div key={`${item.id}:${item.updatedAt}`} className={`background-activity-item is-${item.state}`}>
                <span className="background-activity-item-mark" aria-hidden="true"/>
                <span className="background-activity-item-copy"><b>{itemLabel(item, false)}</b><small>{recentStateLabel(item, t)} · {formatTime(item.completedAt ?? item.updatedAt, locale)}</small>{item.errorSummary && <small className="background-activity-error" title={item.errorSummary}>{item.errorSummary}</small>}</span>
              </div>)}</div>
            : <div className="background-activity-empty">{t('backgroundActivity.noRecent')}</div>}
        </div>

        {loadError && <div className="background-activity-load-error">{t('backgroundActivity.retrying', { error: loadError })}</div>}
      </section>
    </Popover>
  </div>
}
