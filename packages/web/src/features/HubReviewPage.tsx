import { useEffect, useMemo, useState } from 'react'
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

const omittedReasonLabel: Record<Extract<HubReadAvailability, { state: 'omitted' }>['reason'], string> = {
  policy: '复制策略未同步',
  'not-captured': '来源未采集',
  'history-boundary': '历史边界前未回填',
  'dependency-minimized': '仅同步最小依赖',
}

function formatValue(value: JsonValue): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function availabilityText(value: HubReadAvailability): string {
  switch (value.state) {
    case 'value': return formatValue(value.value)
    case 'null': return '空值（来源明确记录为 null）'
    case 'redacted': return '内容已脱敏'
    case 'omitted': return omittedReasonLabel[value.reason]
  }
}

function availabilityTone(value: HubReadAvailability): string {
  return value.state === 'value' ? 'value' : value.state === 'redacted' ? 'redacted' : value.state === 'omitted' ? 'omitted' : 'null'
}

function valueString(value: HubReadAvailability): string | null {
  return value.state === 'value' && typeof value.value === 'string' ? value.value : null
}

function sessionAvailabilityLabel(value: HubReadAvailability, fallback: string): string {
  const text = valueString(value)?.trim()
  if (text) return text
  if (value.state === 'redacted') return '已脱敏'
  if (value.state === 'omitted') return value.reason === 'policy' ? '标题未同步' : omittedReasonLabel[value.reason]
  return fallback
}

function sessionDate(value: HubReadAvailability): string | null {
  const text = valueString(value)
  return text && Number.isFinite(Date.parse(text)) ? text : null
}

function localDayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
}

function sessionDayLabel(value: string | null, now = new Date()): '今天' | '昨天' | '更早' {
  if (!value) return '更早'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '更早'
  const day = localDayStart(date)
  const today = localDayStart(now)
  if (day === today) return '今天'
  if (day === today - 86_400_000) return '昨天'
  return '更早'
}

function sessionRelativeTime(value: string | null, now = new Date()): string {
  if (!value) return '时间未同步'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未同步'
  const diff = Math.max(0, now.getTime() - date.getTime())
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000 && sessionDayLabel(value, now) === '今天') return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function timeLabel(item: HubReviewTimelineItemDto): string {
  const raw = valueString(item.occurredAt) ?? valueString(item.capturedAt)
  if (!raw || !Number.isFinite(Date.parse(raw))) return availabilityText(item.occurredAt)
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(raw))
}

function AvailabilityBadge({ value }: { value: HubReadAvailability }) {
  if (value.state === 'value') return null
  return <span className="hub-review-availability" data-state={availabilityTone(value)}>{availabilityText(value)}</span>
}

function TimelineItem({ item }: { item: HubReviewTimelineItemDto }) {
  const kind = valueString(item.kind) ?? '类型未同步'
  return <article className="hub-review-item" data-origin={item.origin.kind}>
    <header className="hub-review-item-head">
      <div>
        <span className="hub-review-origin">{item.origin.kind === 'remote' ? '远程节点' : '本机'}</span>
        <strong>{kind}</strong>
        <span>{timeLabel(item)}</span>
      </div>
      <code title={item.id}>{item.id}</code>
    </header>
    <div className="hub-review-payload" data-state={availabilityTone(item.payload)}>
      {item.payload.state === 'value'
        ? <CopyableCodeBlock copyValue={formatValue(item.payload.value)}>{formatValue(item.payload.value)}</CopyableCodeBlock>
        : <div className="hub-review-unavailable"><AvailabilityBadge value={item.payload}/><small>AgentLens 不会用空字符串或空对象代替未同步内容。</small></div>}
    </div>
    {Object.keys(item.references).length > 0 && <details className="hub-review-refs">
      <summary><UiIcon className="hub-review-refs-chevron" name="chevron-right" size={14}/><span>引用 {Object.keys(item.references).length}</span></summary>
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
      if (failures.length === 2) setListError('会话列表读取失败')
      else if (failures.length === 1) setListError('部分会话暂不可用')
      setListLoading(false)
    })
    return () => { cancelled = true }
  }, [embedded])

  const title = useMemo(() => {
    if (!detail) return '远程会话'
    return detail.title.state === 'value' && typeof detail.title.value === 'string' && detail.title.value.trim()
      ? detail.title.value.trim()
      : sessionAvailabilityLabel(detail.title, '远程会话')
  }, [detail])

  const sessionGroups = useMemo(() => {
    const mixed: MixedSession[] = [
      ...localSessions.map(item => ({
        kind: 'local' as const,
        item,
        id: item.id,
        title: item.title?.trim() || item.preview?.trim() || item.projectName?.trim() || '本机会话',
        time: item.endedAt || item.startedAt || null,
      })),
      ...remoteSessions.map(item => ({
        kind: 'remote' as const,
        item,
        id: item.id,
        title: sessionAvailabilityLabel(item.title, '远程会话'),
        time: sessionDate(item.endedAt) ?? sessionDate(item.startedAt),
      })),
    ].sort((left, right) => {
      const time = mixedSessionTime(right) - mixedSessionTime(left)
      return time || left.id.localeCompare(right.id)
    })
    const groups = new Map<'今天' | '昨天' | '更早', MixedSession[]>()
    const now = new Date()
    for (const item of mixed) {
      const label = sessionDayLabel(item.time, now)
      const entries = groups.get(label) ?? []
      entries.push(item)
      groups.set(label, entries)
    }
    return [...groups.entries()].map(([label, items]) => ({ label, items }))
  }, [localSessions, remoteSessions])

  const selectSession = (item: MixedSession) => {
    navigate(item.kind === 'remote'
      ? `/review/hub/${encodeURIComponent(item.id)}`
      : `/review/${encodeURIComponent(item.id)}`)
  }

  return <main className={`review-page hub-review-page ${embedded ? 'hub-review-page-embedded' : ''}`}>
    {!embedded && <div className="workspace-toolbar hub-review-toolbar">
      <IconButton className="icon-button hub-review-back" onClick={() => navigate('/review')} aria-label="返回任务复盘"><UiIcon name="arrow-left" size={16}/></IconButton>
      <div>
        <b>任务复盘</b>
        <span>本机与 Hub 当前 active Generation 会话统一浏览。</span>
      </div>
    </div>}
    <div className="review-layout">
      {!embedded && <aside className="session-panel">
        <div className="session-panel-head"><div><b>会话</b><span>本机 + 远程 · 按时间倒序</span></div><span className="count-badge">{localSessions.length + remoteSessions.length}</span></div>
        <div className="session-scroll">
          {listLoading && <div className="empty-state">加载会话…</div>}
          {listError && <div className="hub-session-list-warning">{listError}</div>}
          {sessionGroups.map(group => <section className="session-group-block" key={group.label}>
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
                  <span className={`hub-session-source ${remote ? 'remote' : 'local'}`}>{remote ? `远程 · ${nodeId}` : '本机'}</span>
                  <time>{sessionRelativeTime(entry.time)}</time>
                </div>
                <div className="session-item-title">{entry.title}</div>
                <div className="session-item-foot">
                  {remote
                    ? <><span>{entry.item.title.state === 'redacted' ? '标题已脱敏' : entry.item.title.state === 'omitted' ? '部分字段未同步' : 'Hub 会话'}</span><span>{nodeId}</span></>
                    : <><span>{local?.projectName ?? local?.workspacePath?.split(/[\\/]/).pop() ?? '无项目'}</span><span>{local?.toolCount ?? 0} 调用{(local?.errorCount ?? 0) > 0 ? ` · ${local?.errorCount} 错误` : ''}</span></>}
                </div>
              </button>
            })}
          </section>)}
          {!listLoading && !sessionGroups.length && <div className="empty-state">当前没有可读取的会话</div>}
        </div>
      </aside>}

      <TaskSurface mode="hub" className="review-reader-pane hub-review-reader-pane">
        {loading && <div className="empty-state fill">加载远程会话…</div>}
        {error && <div className="page-error">{error}</div>}
        {!loading && !error && detail && <div className="review-reader hub-review-reader">
          <header className="review-session-head">
            <div className="review-session-copy">
              <div className="review-session-meta">
                <span className="hub-review-origin">{detail.origin.kind === 'remote' ? '远程节点' : '本机'}</span>
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
              <div className="review-metric"><b>{detail.meta.count}</b><span>记录</span></div>
            </div>
          </header>
          <div className="hub-review-policy-note">
            <b>内容可用性</b>
            <span><i data-state="redacted"/>已脱敏</span>
            <span><i data-state="omitted"/>未同步</span>
            <small>未同步不等于空内容，也不会被当作本机完整 Observation。</small>
          </div>
          <div className="review-flow hub-review-flow">
            {detail.items.map(item => <TimelineItem key={item.id} item={item}/>)}
            {!detail.items.length && <div className="empty-state">当前会话没有可读取的远程记录。</div>}
          </div>
        </div>}
      </TaskSurface>
    </div>
  </main>
}
