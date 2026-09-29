import { useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { BackgroundActivityItemDto, BackgroundActivityResponseDto, HealthResponseDto } from '@agent-lens/protocol'
import { BACKGROUND_ACTIVITY_CHANGED_EVENT, fetchBackgroundActivity } from '../client/background-activity'
import { agentLabel, useOrderedAgents } from './AgentScope'
import { backgroundActivityLabel, summarizeBackgroundActivity } from './background-activity-presenter'
import { Disclosure, Popover, StatusBadge, type StatusTone } from './ui'
import './background-activity-status.css'

function formatTime(value: string, locale: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
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
  if (item.state === 'cancelled') return t('backgroundActivity.stateCancelled')
  if (item.state === 'interrupted') return t('backgroundActivity.stateInterrupted')
  if (item.state === 'pending') return t('backgroundActivity.pending')
  if (item.state === 'running') return t('backgroundActivity.running')
  if (item.state === 'failed') return t('backgroundActivity.stateFailed')
  if (item.state === 'degraded') return t('backgroundActivity.stateDegraded')
  if (item.state === 'paused') return t('backgroundActivity.statePaused')
  return t('backgroundActivity.stateCompleted')
}

function stateTone(state: BackgroundActivityItemDto['state']): StatusTone {
  if (state === 'completed') return 'success'
  if (state === 'failed' || state === 'degraded') return 'danger'
  if (state === 'running') return 'accent'
  if (state === 'interrupted' || state === 'cancelled' || state === 'paused') return 'warning'
  return 'neutral'
}

function syncStepLabel(item: BackgroundActivityItemDto, t: TFunction): string {
  const step = item.sync?.steps.find(value => value.state === 'running')
  return step ? t(`backgroundActivity.steps.${step.id}`) : recentStateLabel(item, t)
}

function SyncTimeline({ item, locale }: { item: BackgroundActivityItemDto; locale: string }) {
  const { t } = useTranslation('common')
  const progress = item.sync
  return <div className="background-sync-detail">
    {progress ? <>
      <ol className="background-sync-timeline" aria-label={t('backgroundActivity.syncSteps')}>
        {progress.steps.map(step => <li key={step.id} className={`is-${step.state}`} aria-current={step.state === 'running' ? 'step' : undefined}>
          <div className="background-sync-node">
            <StatusBadge dot tone={stateTone(step.state)}>{t(`backgroundActivity.steps.${step.id}`)}</StatusBadge>
            <span>{step.state === 'pending' && progress.state !== 'pending' && progress.state !== 'running'
              ? t('backgroundActivity.notExecuted') : recentStateLabel({ ...item, state: step.state }, t)}</span>
          </div>
          {(step.completedAt || step.startedAt) && <time dateTime={step.completedAt ?? step.startedAt}>{formatTime((step.completedAt ?? step.startedAt)!, locale)}</time>}
          {step.id === 'scanning' && progress.discoveredUnits !== undefined && <small>{t('backgroundActivity.discoveredUnits', { count: progress.discoveredUnits })}</small>}
          {step.id === 'processing' && step.state !== 'pending' && <small>{progress.processedUnits !== undefined
            ? t('backgroundActivity.processedUnits', { count: progress.processedUnits, total: progress.discoveredUnits ?? progress.processedUnits })
            : t('backgroundActivity.processedRecords', { count: progress.records })}</small>}
        </li>)}
      </ol>
      <div className="background-sync-progress">
        <span>{t('backgroundActivity.processedRecords', { count: progress.records })}</span>
        {progress.currentUnit && <span className="background-sync-current" title={progress.currentUnit}>{t('backgroundActivity.currentUnit', { name: progress.currentUnit.replace(/\\/g, '/').split('/').at(-1) })}</span>}
        <span>{t('backgroundActivity.lastProgress', { time: formatTime(progress.updatedAt, locale) })}</span>
      </div>
    </> : <div className="background-sync-progress">
      <StatusBadge dot tone={stateTone(item.state)}>{recentStateLabel(item, t)}</StatusBadge>
      <span>{t('backgroundActivity.legacySync')}</span>
      <span>{t('backgroundActivity.lastProgress', { time: formatTime(item.updatedAt, locale) })}</span>
    </div>}
    {item.state === 'interrupted' && <p className="background-sync-note">{t('backgroundActivity.interruptedHint')}</p>}
    {item.errorSummary && <p className="background-sync-error">{item.errorSummary}</p>}
  </div>
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
    let refreshing = false
    let refreshRequested = false

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
        schedule(30_000)
        return
      }
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
      // 一轮扫描的多个阶段事件合并成一次读取，不中断正在进行的请求。
      schedule(150)
    }
    const onVisibilityChange = () => {
      if (document.hidden) return
      clearTimer()
      void refresh()
    }

    schedule(open ? 0 : 2_000)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener(BACKGROUND_ACTIVITY_CHANGED_EVENT, onProgress)
    return () => {
      disposed = true
      clearTimer()
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener(BACKGROUND_ACTIVITY_CHANGED_EVENT, onProgress)
    }
  }, [open])

  const syncGroups = useMemo(() => {
    const items = activity?.sources ?? [...(activity?.active ?? []), ...(activity?.recent ?? [])].filter(item => item.kind === 'source-history')
    const groups = new Map<string, BackgroundActivityItemDto[]>()
    for (const item of items) {
      const key = item.sourceId ?? ''
      const values = groups.get(key) ?? []
      if (!values.some(value => value.id === item.id)) values.push(item)
      groups.set(key, values)
    }
    return [...groups].map(([sourceId, items]) => ({ sourceId, items }))
  }, [activity])
  const orderedSyncGroups = useOrderedAgents(syncGroups)
  const otherActive = activity?.active.filter(item => item.kind !== 'source-history') ?? []
  const otherRecent = activity?.recent.filter(item => item.kind !== 'source-history') ?? []

  const summary = useMemo(() => {
    if (loadError) return { tone: 'warning', label: t('backgroundActivity.statusUnavailable') }
    const base = summarizeBackgroundActivity(activity)
    const primary = activity?.active[0]
    if (!primary) return base
    const suffix = activity!.active.length > 1 ? t('backgroundActivity.moreActive', { count: activity!.active.length - 1 }) : ''
    return { ...base, label: `${primary.sync ? `${agentLabel(primary.sourceId ?? '')}：${syncStepLabel(primary, t)}` : itemLabel(primary, true)}${suffix}` }
  }, [activity, loadError, t])

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
          <div><b>{t('backgroundActivity.title')}</b></div>
          <span className={`background-activity-state is-${summary.tone}`}>{activity?.active.length ? t('backgroundActivity.processingCount', { count: activity.active.length }) : t('backgroundActivity.recentRecord')}</span>
        </header>

        <div className={`background-activity-process is-${runtimeTone}`}><span className="background-activity-process-dot" aria-hidden="true"/><span>{runtimeText}</span></div>

        {syncGroups.length > 0 && <div className="background-activity-section">
          <div className="background-activity-section-title">{t('backgroundActivity.agentSync')}</div>
          <div className="background-sync-groups">{orderedSyncGroups.map(({ sourceId, items }) => {
            const primary = items.find(item => item.state === 'running') ?? items.find(item => item.state === 'pending') ?? items[0]!
            return <Disclosure key={sourceId} className="background-sync-group"
              summary={<span className="background-sync-summary"><b>{agentLabel(sourceId)}</b><small>{syncStepLabel(primary, t)}</small></span>}
              summaryMeta={<StatusBadge dot tone={stateTone(primary.state)}>{recentStateLabel(primary, t)}</StatusBadge>}>
              {items.map((item, index) => <div key={item.id}>
                {items.length > 1 && <div className="background-sync-task">{t('backgroundActivity.syncTarget', { index: index + 1 })}</div>}
                <SyncTimeline item={item} locale={locale}/>
              </div>)}
            </Disclosure>
          })}</div>
        </div>}

        {otherActive.length > 0 && <div className="background-activity-section">
          <div className="background-activity-section-title">{t('backgroundActivity.processing')}</div>
          {otherActive.length
            ? <div className="background-activity-list">{otherActive.map(item => <div key={item.id} className="background-activity-item is-active">
                <span className="background-activity-item-mark" aria-hidden="true"/>
                <span className="background-activity-item-copy"><b>{itemLabel(item, true)}</b><small>{item.startedAt ? t('backgroundActivity.startedAt', { time: formatTime(item.startedAt, locale) }) : item.state === 'pending' ? t('backgroundActivity.pending') : t('backgroundActivity.running')}</small></span>
              </div>)}</div>
            : <div className="background-activity-empty">{t('backgroundActivity.noActive')}</div>}
        </div>}

        {(otherRecent.length > 0 || syncGroups.length === 0) && <div className="background-activity-section">
          <div className="background-activity-section-title">{t('backgroundActivity.recent')}</div>
          {otherRecent.length
            ? <div className="background-activity-list">{otherRecent.map(item => <div key={`${item.id}:${item.updatedAt}`} className={`background-activity-item is-${item.state}`}>
                <span className="background-activity-item-mark" aria-hidden="true"/>
                <span className="background-activity-item-copy"><b>{itemLabel(item, false)}</b><small>{recentStateLabel(item, t)} · {formatTime(item.completedAt ?? item.updatedAt, locale)}</small>{item.errorSummary && <small className="background-activity-error" title={item.errorSummary}>{item.errorSummary}</small>}</span>
              </div>)}</div>
            : <div className="background-activity-empty">{t('backgroundActivity.noRecent')}</div>}
        </div>}

        {loadError && <div className="background-activity-load-error">{t('backgroundActivity.retrying', { error: loadError })}</div>}
      </section>
    </Popover>
  </div>
}
