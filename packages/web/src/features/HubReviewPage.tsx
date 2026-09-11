import { useEffect, useMemo, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import type {
  HubReadAvailability,
  HubReviewDetailDto,
  HubReviewSessionSummaryDto,
  HubReviewTimelineItemDto,
  JsonValue,
  ReviewSessionSummaryDto,
} from '@agent-lens/protocol'
import {
  fetchHubReviewDetail,
  fetchHubReviewSessions,
  fetchLocalReviewSessions,
} from '../client/hub-review'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { IconButton, UiIcon } from '../components/ui'
import { TaskSurface } from './TaskSurface'

const omittedReasonKey: Record<Extract<HubReadAvailability, { state: 'omitted' }>['reason'], string> = {
  policy: 'hub.omittedReason.policy',
  'not-captured': 'hub.omittedReason.notCaptured',
  'history-boundary': 'hub.omittedReason.historyBoundary',
  'dependency-minimized': 'hub.omittedReason.dependencyMinimized',
}

function formatValue(value: JsonValue): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function availabilityText(value: HubReadAvailability, t: TFunction): string {
  switch (value.state) {
    case 'value': return formatValue(value.value)
    case 'null': return t('hub.availability.nullValue')
    case 'redacted': return t('hub.availability.redactedContent')
    case 'omitted': return t(omittedReasonKey[value.reason])
  }
}

function availabilityTone(value: HubReadAvailability): string {
  return value.state === 'value' ? 'value' : value.state === 'redacted' ? 'redacted' : value.state === 'omitted' ? 'omitted' : 'null'
}

function valueString(value: HubReadAvailability): string | null {
  return value.state === 'value' && typeof value.value === 'string' ? value.value : null
}

function sessionAvailabilityLabel(value: HubReadAvailability, fallback: string, t: TFunction): string {
  const text = valueString(value)?.trim()
  if (text) return text
  if (value.state === 'redacted') return t('hub.availability.redacted')
  if (value.state === 'omitted') return value.reason === 'policy' ? t('hub.availability.titleNotSynced') : t(omittedReasonKey[value.reason])
  return fallback
}

function sessionDate(value: HubReadAvailability): string | null {
  const text = valueString(value)
  return text && Number.isFinite(Date.parse(text)) ? text : null
}

function localDayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
}

type HubDayGroup = 'today' | 'yesterday' | 'earlier'

function sessionDayLabel(value: string | null, now = new Date()): HubDayGroup {
  if (!value) return 'earlier'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'earlier'
  const day = localDayStart(date)
  const today = localDayStart(now)
  if (day === today) return 'today'
  if (day === today - 86_400_000) return 'yesterday'
  return 'earlier'
}

function sessionRelativeTime(value: string | null, t: TFunction, locale: string, now = new Date()): string {
  if (!value) return t('hub.time.notSynced')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return t('hub.time.notSynced')
  const diff = Math.max(0, now.getTime() - date.getTime())
  if (diff < 60_000) return t('hub.time.justNow')
  if (diff < 3_600_000) return t('hub.time.minutesAgo', { count: Math.floor(diff / 60_000) })
  if (diff < 86_400_000 && sessionDayLabel(value, now) === 'today') return t('hub.time.hoursAgo', { count: Math.floor(diff / 3_600_000) })
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function timeLabel(item: HubReviewTimelineItemDto, t: TFunction, locale: string): string {
  const raw = valueString(item.occurredAt) ?? valueString(item.capturedAt)
  if (!raw || !Number.isFinite(Date.parse(raw))) return availabilityText(item.occurredAt, t)
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(raw))
}

function AvailabilityBadge({ value }: { value: HubReadAvailability }) {
  const { t } = useTranslation('review')
  if (value.state === 'value') return null
  return <span className="hub-review-availability" data-state={availabilityTone(value)}>{availabilityText(value, t)}</span>
}

function TimelineItem({ item }: { item: HubReviewTimelineItemDto }) {
  const { t, i18n } = useTranslation('review')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const kind = valueString(item.kind) ?? t('hub.timeline.typeNotSynced')
  return <article className="hub-review-item" data-origin={item.origin.kind}>
    <header className="hub-review-item-head">
      <div>
        <span className="hub-review-origin">{item.origin.kind === 'remote' ? t('hub.timeline.remoteNode') : t('hub.timeline.local')}</span>
        <strong>{kind}</strong>
        <span>{timeLabel(item, t, locale)}</span>
      </div>
      <code title={item.id}>{item.id}</code>
    </header>
    <div className="hub-review-payload" data-state={availabilityTone(item.payload)}>
      {item.payload.state === 'value'
        ? <CopyableCodeBlock copyValue={formatValue(item.payload.value)}>{formatValue(item.payload.value)}</CopyableCodeBlock>
        : <div className="hub-review-unavailable"><AvailabilityBadge value={item.payload}/><small>{t('hub.timeline.unavailableNote')}</small></div>}
    </div>
    {Object.keys(item.references).length > 0 && <details className="hub-review-refs">
      <summary><UiIcon className="hub-review-refs-chevron" name="chevron-right" size={14}/><span>{t('hub.timeline.references', { count: Object.keys(item.references).length })}</span></summary>
      <div>{Object.entries(item.references).map(([key, value]) => {
        const refs = Array.isArray(value) ? value : [value]
        return <div key={key}><b>{key}</b>{refs.map(ref => <code key={`${ref.entityType}:${ref.publicId}`}>{ref.entityType} · {ref.publicId}</code>)}</div>
      })}</div>
    </details>}
  </article>
}

type MixedSession =
  | { kind: 'local'; item: ReviewSessionSummaryDto; id: string; title: string; time: string | null }
  | { kind: 'remote'; item: HubReviewSessionSummaryDto; id: string; title: string; time: string | null }

function mixedSessionTime(item: MixedSession): number {
  return item.time ? Date.parse(item.time) : Number.NEGATIVE_INFINITY
}

export function HubReviewPage({ embedded = false }: { embedded?: boolean }) {
  const { t, i18n } = useTranslation('review')
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()
  const [detail, setDetail] = useState<HubReviewDetailDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [localSessions, setLocalSessions] = useState<ReviewSessionSummaryDto[]>([])
  const [remoteSessions, setRemoteSessions] = useState<HubReviewSessionSummaryDto[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setDetail(null)
    void fetchHubReviewDetail(sessionId).then(
      value => {
        if (cancelled) return
        setDetail(value)
        setLoading(false)
      },
      reason => {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      },
    )
    return () => { cancelled = true }
  }, [sessionId])

  useEffect(() => {
    if (embedded) {
      setLocalSessions([])
      setRemoteSessions([])
      setListLoading(false)
      setListError('')
      return
    }
    let cancelled = false
    setListLoading(true)
    setListError('')
    void Promise.allSettled([
      fetchLocalReviewSessions(200),
      fetchHubReviewSessions(200),
    ]).then(([local, remote]) => {
      if (cancelled) return
      if (local.status === 'fulfilled') setLocalSessions(local.value.items)
      if (remote.status === 'fulfilled') setRemoteSessions(remote.value.items.filter(item => item.origin.kind === 'remote'))
      const failures = [local, remote].filter(result => result.status === 'rejected') as PromiseRejectedResult[]
      if (failures.length === 2) setListError(t('hub.list.failed'))
      else if (failures.length === 1) setListError(t('hub.list.partial'))
      setListLoading(false)
    })
    return () => { cancelled = true }
  }, [embedded, t])

  const title = useMemo(() => {
    if (!detail) return t('hub.list.remoteSession')
    return detail.title.state === 'value' && typeof detail.title.value === 'string' && detail.title.value.trim()
      ? detail.title.value.trim()
      : sessionAvailabilityLabel(detail.title, t('hub.list.remoteSession'), t)
  }, [detail, t])

  const sessionGroups = useMemo(() => {
    const mixed: MixedSession[] = [
      ...localSessions.map(item => ({
        kind: 'local' as const,
        item,
        id: item.id,
        title: item.title?.trim() || item.preview?.trim() || item.projectName?.trim() || t('hub.list.localSession'),
        time: item.endedAt || item.startedAt || null,
      })),
      ...remoteSessions.map(item => ({
        kind: 'remote' as const,
        item,
        id: item.id,
        title: sessionAvailabilityLabel(item.title, t('hub.list.remoteSession'), t),
        time: sessionDate(item.endedAt) ?? sessionDate(item.startedAt),
      })),
    ].sort((left, right) => {
      const time = mixedSessionTime(right) - mixedSessionTime(left)
      return time || left.id.localeCompare(right.id)
    })
    const groups = new Map<HubDayGroup, MixedSession[]>()
    const now = new Date()
    for (const item of mixed) {
      const label = sessionDayLabel(item.time, now)
      const entries = groups.get(label) ?? []
      entries.push(item)
      groups.set(label, entries)
    }
    return [...groups.entries()].map(([key, items]) => ({
      key,
      label: t(`hub.day.${key}`),
      items,
    }))
  }, [localSessions, remoteSessions, t])

  const selectSession = (item: MixedSession) => {
    navigate(item.kind === 'remote'
      ? `/review/hub/${encodeURIComponent(item.id)}`
      : `/review/${encodeURIComponent(item.id)}`)
  }

  return <main className={`review-page hub-review-page ${embedded ? 'hub-review-page-embedded' : ''}`}>
    {!embedded && <div className="workspace-toolbar hub-review-toolbar">
      <IconButton className="icon-button hub-review-back" onClick={() => navigate('/review')} aria-label={t('hub.list.back')}><UiIcon name="arrow-left" size={16}/></IconButton>
      <div>
        <b>{t('hub.list.title')}</b>
        <span>{t('hub.list.description')}</span>
      </div>
    </div>}
    <div className="review-layout">
      {!embedded && <aside className="session-panel">
        <div className="session-panel-head"><div><b>{t('hub.list.sessions')}</b><span>{t('hub.list.ordering')}</span></div><span className="count-badge">{localSessions.length + remoteSessions.length}</span></div>
        <div className="session-scroll">
          {listLoading && <div className="empty-state">{t('hub.list.loading')}</div>}
          {listError && <div className="hub-session-list-warning">{listError}</div>}
          {sessionGroups.map(group => <section className="session-group-block" key={group.key}>
            <div className="session-group">{group.label}</div>
            {group.items.map(entry => {
              const remote = entry.kind === 'remote'
              const nodeId = remote ? entry.item.origin.nodeId : ''
              const local = !remote ? entry.item : null
              return <button
                key={`${entry.kind}:${entry.id}`}
                className={`session-item ${remote && entry.id === sessionId ? 'session-item-active' : ''}`}
                onClick={() => selectSession(entry)}
              >
                <div className="session-item-meta">
                  <span className={`hub-session-source ${remote ? 'remote' : 'local'}`}>{remote ? t('hub.list.remote', { node: nodeId }) : t('hub.timeline.local')}</span>
                  <time>{sessionRelativeTime(entry.time, t, locale)}</time>
                </div>
                <div className="session-item-title">{entry.title}</div>
                <div className="session-item-foot">
                  {remote
                    ? <><span>{entry.item.title.state === 'redacted' ? t('hub.availability.redacted') : entry.item.title.state === 'omitted' ? t('hub.list.partialFields') : t('hub.list.hubSession')}</span><span>{nodeId}</span></>
                    : <><span>{local?.projectName ?? local?.workspacePath?.split(/[\\/]/).pop() ?? t('hub.list.noProject')}</span><span>{t('hub.list.calls', { count: local?.toolCount ?? 0 })}{(local?.errorCount ?? 0) > 0 ? t('hub.list.errors', { count: local?.errorCount ?? 0 }) : ''}</span></>}
                </div>
              </button>
            })}
          </section>)}
          {!listLoading && !sessionGroups.length && <div className="empty-state">{t('hub.list.empty')}</div>}
        </div>
      </aside>}

      <TaskSurface mode="hub" className="review-reader-pane hub-review-reader-pane">
        {loading && <div className="empty-state fill">{t('hub.detail.loading')}</div>}
        {error && <div className="page-error">{error}</div>}
        {!loading && !error && detail && <div className="review-reader hub-review-reader">
          <header className="review-session-head">
            <div className="review-session-copy">
              <div className="review-session-meta">
                <span className="hub-review-origin">{detail.origin.kind === 'remote' ? t('hub.timeline.remoteNode') : t('hub.timeline.local')}</span>
                <b>{detail.origin.nodeId}</b>
                {detail.origin.generationId && <span>Generation {detail.origin.generationId}</span>}
              </div>
              <h1 className="review-session-title">{title}</h1>
              <div className="review-session-submeta">
                <code title={detail.logicalSessionId}>{detail.logicalSessionId}</code>
                <AvailabilityBadge value={detail.title}/>
              </div>
            </div>
            <div className="review-metrics">
              <div className="review-metric"><b>{detail.meta.count}</b><span>{t('hub.detail.records')}</span></div>
            </div>
          </header>
          <div className="hub-review-policy-note">
            <b>{t('hub.detail.availability')}</b>
            <span><i data-state="redacted"/>{t('hub.detail.redacted')}</span>
            <span><i data-state="omitted"/>{t('hub.detail.omitted')}</span>
            <small>{t('hub.detail.availabilityNote')}</small>
          </div>
          <div className="review-flow hub-review-flow">
            {detail.items.map(item => <TimelineItem key={item.id} item={item}/>)}
            {!detail.items.length && <div className="empty-state">{t('hub.detail.empty')}</div>}
          </div>
        </div>}
      </TaskSurface>
    </div>
  </main>
}
