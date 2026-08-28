import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type {
  HubReadAvailability,
  HubReviewDetailDto,
  HubReviewTimelineItemDto,
  JsonValue,
} from '@agent-lens/protocol'
import { fetchHubReviewDetail } from '../client/hub-review'

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
        ? <pre>{formatValue(item.payload.value)}</pre>
        : <div className="hub-review-unavailable"><AvailabilityBadge value={item.payload}/><small>AgentLens 不会用空字符串或空对象代替未同步内容。</small></div>}
    </div>
    {Object.keys(item.references).length > 0 && <details className="hub-review-refs">
      <summary>引用 {Object.keys(item.references).length}</summary>
      <div>{Object.entries(item.references).map(([key, value]) => {
        const refs = Array.isArray(value) ? value : [value]
        return <div key={key}><b>{key}</b>{refs.map(ref => <code key={`${ref.entityType}:${ref.publicId}`}>{ref.entityType} · {ref.publicId}</code>)}</div>
      })}</div>
    </details>}
  </article>
}

export function HubReviewPage() {
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()
  const [detail, setDetail] = useState<HubReviewDetailDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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

  const title = useMemo(() => {
    if (!detail) return '远程会话'
    return detail.title.state === 'value' && typeof detail.title.value === 'string' && detail.title.value.trim()
      ? detail.title.value.trim()
      : '远程会话'
  }, [detail])

  return <main className="review-page hub-review-page">
    <div className="workspace-toolbar hub-review-toolbar">
      <button className="icon-button hub-review-back" onClick={() => navigate('/review')} aria-label="返回本机会话">←</button>
      <div>
        <b>多机任务复盘</b>
        <span>读取 Hub 当前 active Generation；内容可用性按复制策略原样显示。</span>
      </div>
    </div>
    <section className="review-reader-pane hub-review-reader-pane">
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
    </section>
  </main>
}
