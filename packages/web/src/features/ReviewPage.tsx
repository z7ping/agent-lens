import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useNavigate, useParams } from 'react-router-dom'
import type {
  ReviewEventNodeDto,
  ReviewMessageNodeDto,
  ReviewNodeDto,
  ReviewToolNodeDto,
} from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentScope, agentLabel, sourceDot } from '../components/AgentScope'

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatClock(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value))
}

function formatRange(start: string, end: string): string {
  const left = new Date(start)
  const right = new Date(end)
  const sameDay = left.toDateString() === right.toDateString()
  const date = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(left)
  return sameDay ? `${date} ${formatClock(start)} – ${formatClock(end)}` : `${formatTime(start)} – ${formatTime(end)}`
}

function duration(ms: number): string {
  const value = Math.max(0, ms)
  if (value < 1000) return `${value}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`
  if (value < 86_400_000) {
    const hours = value / 3_600_000
    return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`
  }
  const days = value / 86_400_000
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}天`
}

function compactTitle(value: string | undefined, max = 92): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (!text) return '未命名会话'
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function brief(value: unknown, max = 120): string {
  if (value === undefined || value === null) return ''
  let text: string
  if (typeof value === 'string') text = value
  else {
    try { text = JSON.stringify(value) ?? String(value) } catch { text = String(value) }
  }
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized
}

function sourceEventLabel(node: ReviewEventNodeDto): string {
  const payload = payloadRecord(node.payload)
  const action = typeof payload.action === 'string' ? payload.action : typeof payload.event === 'string' ? payload.event : ''
  if (node.sourceId === 'codex') {
    if (node.kind === 'context.compaction') return '上下文压缩'
    if (node.kind === 'subagent.spawn') return '启动 Subagent'
    if (node.kind === 'subagent.end') return 'Subagent 完成'
    if (node.kind === 'permission.request') return '权限请求'
    if (node.kind === 'session.lifecycle' && action.toLowerCase().includes('stop')) return 'Turn Stop'
  }
  if (node.sourceId === 'claude-code') {
    if (node.kind === 'permission.request') return '权限请求'
    if (node.kind === 'subagent.spawn') return '启动 Subagent'
    if (node.kind === 'context.summary') return '上下文摘要'
    if (node.kind === 'context.compaction') return '上下文压缩'
  }
  if (node.sourceId === 'pi') {
    if (node.kind === 'model.changed') return '模型切换'
    if (node.kind === 'context.compaction') return '上下文压缩'
    if (node.kind === 'context.summary') return '分支摘要'
  }
  return node.label
}

function isGenericRawEvent(node: ReviewEventNodeDto): boolean {
  if (node.category !== 'unknown') return false
  return /^(原始事件|raw event|event)$/i.test(sourceEventLabel(node).trim())
}

function Inspector({ node, onClose }: { node: ReviewNodeDto; onClose(): void }) {
  return <aside className="inspector-panel">
    <div className="inspector-head">
      <div>
        <div className="eyebrow">事件详情</div>
        <div className="inspector-title">{node.type === 'tool' ? node.name : node.type === 'event' ? sourceEventLabel(node) : node.role}</div>
      </div>
      <button className="icon-button" onClick={onClose} aria-label="关闭事件详情">×</button>
    </div>
    <section className="inspector-section">
      <h3 className="section-label">Evidence</h3>
      {node.evidence.length ? node.evidence.map(item => <div key={item.id} className="evidence-card">
        <div className="evidence-meta"><b>{item.captureMethod}</b><span>{item.derivation}</span><span>{item.confidence}</span></div>
        <div className="evidence-path">{item.sourceLocator?.path ?? item.sourceRecordId ?? item.id}</div>
      </div>) : <div className="muted-empty">无 Evidence</div>}
    </section>
    <section className="inspector-section"><h3 className="section-label">Raw Payload</h3><pre className="raw-json">{JSON.stringify(node.payload, null, 2)}</pre></section>
  </aside>
}

function MessageBubble({ node, inspect }: { node: ReviewMessageNodeDto; inspect(node: ReviewNodeDto): void }) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = node.text.length > 520 || node.text.split('\n').length > 7

  if (node.role === 'reasoning') {
    return <details className="thinking-block">
      <summary>
        <span className="thinking-label">Thinking</span>
        <span className="thinking-preview">{brief(node.text, 78)}</span>
        <time>{formatClock(node.at)}</time>
      </summary>
      <div className="markdown thinking-content"><ReactMarkdown>{node.text}</ReactMarkdown></div>
      {node.evidence.length > 0 && <button className="evidence-link" onClick={() => inspect(node)}>查看证据 · {node.evidence.length}</button>}
    </details>
  }

  const user = node.role === 'user'
  return <div className={`chat-row ${user ? 'chat-row-user' : 'chat-row-agent'}`}>
    <div className={`chat-avatar ${user ? 'chat-avatar-user' : 'chat-avatar-agent'}`}>{user ? '你' : 'AI'}</div>
    <div className={`chat-bubble ${user ? 'chat-bubble-user' : 'chat-bubble-agent'}`}>
      <div className="chat-meta"><span>{user ? '你' : 'Agent'}</span><time>{formatClock(node.at)}</time></div>
      <div className={`markdown chat-content ${collapsible && !expanded ? 'chat-content-collapsed' : ''}`}><ReactMarkdown>{node.text}</ReactMarkdown></div>
      {(collapsible || node.evidence.length > 0) && <div className="chat-actions">
        {collapsible && <button onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开全文'}</button>}
        {node.evidence.length > 0 && <button onClick={() => inspect(node)}>证据 · {node.evidence.length}</button>}
      </div>}
    </div>
  </div>
}

function ToolRow({ node, inspect, last }: { node: ReviewToolNodeDto; inspect(node: ReviewNodeDto): void; last: boolean }) {
  const status = node.status === 'error' ? 'error' : node.status === 'success' ? 'success' : node.status === 'running' ? 'running' : 'unknown'
  const input = brief(node.input, 130)
  const output = brief(node.output, 130)
  return <button className="execution-row" data-status={status} onClick={() => inspect(node)}>
    <span className="execution-rail" aria-hidden="true"><span className="execution-dot"/>{!last && <span className="execution-line"/>}</span>
    <span className="execution-main">
      <span className="execution-name"><b>{node.name}</b><span className="tool-status-label">{node.status === 'error' ? '失败' : node.status === 'success' ? '完成' : node.status === 'running' ? '执行中' : '未知'}</span></span>
      {input && <span className="execution-preview">{input}</span>}
      {output && <span className={`execution-preview ${node.status === 'error' ? 'execution-preview-error' : ''}`}>{output}</span>}
    </span>
    <span className="execution-duration">{node.durationMs !== undefined ? duration(node.durationMs) : formatClock(node.at)}</span>
  </button>
}

function ToolRunGroup({ items, inspect }: { items: ReviewToolNodeDto[]; inspect(node: ReviewNodeDto): void }) {
  const errors = items.filter(item => item.status === 'error').length
  const [expanded, setExpanded] = useState(errors > 0)
  const totalDuration = items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
  const names = [...new Set(items.map(item => item.name))]
  return <details className={`execution-group ${errors ? 'execution-group-error' : ''}`} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>
      <span className="execution-group-icon">↳</span>
      <span className="execution-group-copy"><b>执行过程</b><small>{items.length} 次调用 · {names.slice(0, 3).join(' / ')}{names.length > 3 ? ' …' : ''}</small></span>
      <span className={`execution-summary-status ${errors ? 'is-error' : 'is-ok'}`}>{errors ? `${errors} 个错误` : '完成'}</span>
      {totalDuration > 0 && <span className="execution-total">{duration(totalDuration)}</span>}
    </summary>
    <div className="execution-list">{items.map((node, index) => <ToolRow key={node.id} node={node} inspect={inspect} last={index === items.length - 1}/>)}</div>
  </details>
}

function EventRow({ event, inspect }: { event: ReviewEventNodeDto; inspect(node: ReviewNodeDto): void }) {
  return <button className={`event-row event-${event.category}`} onClick={() => inspect(event)}>
    <span className="event-mark" />
    <span>{sourceEventLabel(event)}</span>
    <span className="event-source">{agentLabel(event.sourceId)}</span>
    <time>{formatClock(event.at)}</time>
  </button>
}

function RawEventGroup({ items, inspect }: { items: ReviewEventNodeDto[]; inspect(node: ReviewNodeDto): void }) {
  return <details className="raw-event-group">
    <summary><span>原始事件 · {items.length}</span><time>{formatClock(items[items.length - 1]?.at ?? '')}</time></summary>
    <div>{items.map(item => <EventRow key={item.id} event={item} inspect={inspect}/>)}</div>
  </details>
}

type InteractionEntry = ReviewNodeDto
  | { type: 'tool-group'; items: ReviewToolNodeDto[] }
  | { type: 'raw-event-group'; items: ReviewEventNodeDto[] }

function Interaction({ ordinal, trigger, nodes, inspect }: { ordinal: number; trigger: 'user' | 'background'; nodes: ReviewNodeDto[]; inspect(node: ReviewNodeDto): void }) {
  const groups = useMemo(() => {
    const result: InteractionEntry[] = []
    let tools: ReviewToolNodeDto[] = []
    let rawEvents: ReviewEventNodeDto[] = []
    const flushTools = () => { if (tools.length) { result.push({ type: 'tool-group', items: tools }); tools = [] } }
    const flushRawEvents = () => { if (rawEvents.length) { result.push({ type: 'raw-event-group', items: rawEvents }); rawEvents = [] } }

    for (const node of nodes) {
      if (node.type === 'tool') {
        flushRawEvents()
        tools.push(node)
        continue
      }
      if (node.type === 'event' && isGenericRawEvent(node)) {
        flushTools()
        rawEvents.push(node)
        continue
      }
      flushTools()
      flushRawEvents()
      result.push(node)
    }
    flushTools()
    flushRawEvents()
    return result
  }, [nodes])

  return <section className="interaction-block">
    <div className="interaction-separator"><span>{trigger === 'background' ? '后台活动' : `第 ${ordinal} 轮`}</span><i/></div>
    <div className="interaction-flow">{groups.map((entry, index) => {
      if (entry.type === 'tool-group') return <ToolRunGroup key={`tools-${index}`} items={entry.items} inspect={inspect}/>
      if (entry.type === 'raw-event-group') return <RawEventGroup key={`raw-${index}`} items={entry.items} inspect={inspect}/>
      if (entry.type === 'message') return <MessageBubble key={entry.id} node={entry} inspect={inspect}/>
      return <EventRow key={entry.id} event={entry as ReviewEventNodeDto} inspect={inspect}/>
    })}</div>
  </section>
}

function Metric({ value, label, tone = '' }: { value: string | number; label: string; tone?: 'danger' | '' }) {
  return <div className="review-metric" data-tone={tone}><b>{value}</b><span>{label}</span></div>
}

export function ReviewPage({ model }: { model: AgentLensClientModel }) {
  const snapshot = useClientSnapshot(model)
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [inspect, setInspect] = useState<ReviewNodeDto | null>(null)
  const review = snapshot.review
  const agents = snapshot.facets?.agents ?? []
  const projects = snapshot.facets?.projects ?? []

  useEffect(() => { if (sessionId && sessionId !== review.selectedId) void model.selectReviewSession(sessionId) }, [sessionId])
  const select = (id: string) => { void model.selectReviewSession(id); navigate(`/review/${encodeURIComponent(id)}`) }

  return <main className="review-page">
    <div className="workspace-toolbar">
      <AgentScope agents={agents} value={review.filters.sourceId} onChange={sourceId => model.setReviewFilters({ sourceId })}/>
      <span className="toolbar-divider" />
      <select className="filter" value={review.filters.projectId} onChange={e => model.setReviewFilters({ projectId: e.target.value })}><option value="">全部项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name ?? p.repositoryIdentity ?? p.id}</option>)}</select>
      <select className="filter" value={review.filters.range} onChange={e => model.setReviewFilters({ range: e.target.value as typeof review.filters.range })}><option value="today">今天</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="all">全部时间</option></select>
      <select className="filter" value={review.filters.status} onChange={e => model.setReviewFilters({ status: e.target.value as typeof review.filters.status })}><option value="all">全部状态</option><option value="clean">无错误</option><option value="with-errors">有错误</option></select>
      <input className="filter search-filter" placeholder="搜索会话…" value={review.filters.search} onChange={e => model.setReviewFilters({ search: e.target.value })}/>
      <button className="icon-button" onClick={() => void model.refreshReview()} title="刷新" aria-label="刷新">↻</button>
    </div>

    <div className="review-layout">
      <aside className="session-panel">
        <div className="session-panel-head"><div><b>会话</b><span>按时间倒序</span></div><span className="count-badge">{review.response?.items.length ?? 0}</span></div>
        <div className="session-scroll">
          {review.loading && !review.response && <div className="empty-state">加载会话…</div>}
          {review.response?.items.map(item => <button key={item.id} className={`session-item ${review.selectedId === item.id ? 'session-item-active' : ''}`} onClick={() => select(item.id)}>
            <div className="session-item-meta"><span className={`source-dot ${sourceDot(item.sourceIds[0] ?? '')}`}/><span>{agentLabel(item.sourceIds[0] ?? '', item.productId)}</span><time>{formatTime(item.endedAt)}</time></div>
            <div className="session-item-title">{compactTitle(item.title ?? item.preview ?? item.projectName, 74)}</div>
            <div className="session-item-foot"><span>{item.projectName ?? item.workspacePath?.split(/[\\/]/).pop() ?? '无项目'}</span><span>{item.toolCount} 调用{item.errorCount > 0 ? ` · ${item.errorCount} 错误` : ''}</span></div>
          </button>)}
          {!review.loading && !review.response?.items.length && <div className="empty-state">当前筛选范围没有会话</div>}
        </div>
      </aside>

      <section className="review-reader-pane">
        {review.error && <div className="page-error">{review.error}</div>}
        {!review.detail ? <div className="empty-state fill">选择一个会话开始复盘</div> : <div className="review-reader">
          <header className="review-session-head">
            <div className="review-session-copy">
              <div className="review-session-meta"><span className={`source-dot ${sourceDot(review.detail.sourceIds[0] ?? '')}`}/><b>{review.detail.sourceIds.map(id => agentLabel(id)).join(' / ')}</b><span>{review.detail.projectName ?? '无项目'}</span>{review.detail.errorCount > 0 && <span className="session-status-error">有错误</span>}</div>
              <h1 className="review-session-title" title={review.detail.title ?? review.detail.preview}>{compactTitle(review.detail.title ?? review.detail.preview)}</h1>
              <div className="review-session-submeta">
                <span>{formatRange(review.detail.startedAt, review.detail.endedAt)}</span>
                {review.detail.workspacePath && <code title={review.detail.workspacePath}>{review.detail.workspacePath}</code>}
              </div>
            </div>
            <div className="review-metrics">
              <Metric value={review.detail.interactionCount} label="轮次"/>
              <Metric value={review.detail.toolCount} label="调用"/>
              {review.detail.errorCount > 0 && <Metric value={review.detail.errorCount} label="错误" tone="danger"/>}
              <Metric value={duration(review.detail.durationMs)} label="跨度"/>
            </div>
          </header>

          {review.detail.sourceIds.includes('pi') && review.relationships?.items.length ? <details className="pi-session-tree">
            <summary>Pi Session Tree · {review.relationships.items.length} 条关系</summary>
            <div>{review.relationships.items.map(item => <div key={item.id}>{item.fromNativeSessionId ?? item.fromSessionId} <span>→</span> {item.toNativeSessionId ?? item.toSessionId}</div>)}</div>
          </details> : null}

          <div className="review-flow">{review.detail.interactions.map(interaction => <Interaction key={interaction.id} ordinal={interaction.ordinal} trigger={interaction.trigger} nodes={interaction.nodes} inspect={setInspect}/>)}</div>
        </div>}
      </section>
    </div>
    {inspect && <Inspector node={inspect} onClose={() => setInspect(null)}/>} 
  </main>
}
