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
  return sameDay ? `${date} ${formatClock(start)} ~ ${formatClock(end)}` : `${formatTime(start)} ~ ${formatTime(end)}`
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60_000)}m`
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
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function sourceEventLabel(node: ReviewEventNodeDto): string {
  const payload = payloadRecord(node.payload)
  const action = typeof payload.action === 'string' ? payload.action : typeof payload.event === 'string' ? payload.event : ''
  if (node.sourceId === 'codex') {
    if (node.kind === 'context.compaction') return 'Codex · 上下文压缩'
    if (node.kind === 'subagent.spawn') return 'Codex · 启动 Subagent'
    if (node.kind === 'subagent.end') return 'Codex · Subagent 完成'
    if (node.kind === 'permission.request') return 'Codex · 权限请求'
    if (node.kind === 'session.lifecycle' && action.toLowerCase().includes('stop')) return 'Codex · Turn Stop'
  }
  if (node.sourceId === 'claude-code') {
    if (node.kind === 'permission.request') return 'Claude · 权限请求'
    if (node.kind === 'subagent.spawn') return 'Claude · 启动 Subagent'
    if (node.kind === 'context.summary') return 'Claude · Summary'
    if (node.kind === 'context.compaction') return 'Claude · Compact'
  }
  if (node.sourceId === 'pi') {
    if (node.kind === 'model.changed') return 'Pi · 模型切换'
    if (node.kind === 'context.compaction') return 'Pi · Compaction'
    if (node.kind === 'context.summary') return 'Pi · Branch Summary'
  }
  return node.label
}

function Inspector({ node, onClose }: { node: ReviewNodeDto; onClose(): void }) {
  return <div className="fixed inset-y-0 right-0 z-50 w-[min(520px,92vw)] overflow-y-auto border-l border-line bg-surface p-5 shadow-2xl">
    <div className="mb-5 flex items-center justify-between">
      <div><div className="text-xs text-muted">事件检查器</div><div className="font-semibold">{node.type === 'tool' ? node.name : node.type === 'event' ? sourceEventLabel(node) : node.role}</div></div>
      <button className="icon-button" onClick={onClose}>×</button>
    </div>
    <section className="space-y-2">
      <h3 className="section-label">Evidence</h3>
      {node.evidence.length ? node.evidence.map(item => <div key={item.id} className="rounded-lg border border-line bg-soft p-3 text-xs">
        <div className="flex gap-2"><b>{item.captureMethod}</b><span>{item.derivation}</span><span>{item.confidence}</span></div>
        <div className="mt-1 break-all text-muted">{item.sourceLocator?.path ?? item.sourceRecordId ?? item.id}</div>
      </div>) : <div className="text-sm text-muted">无 Evidence</div>}
    </section>
    <section className="mt-6"><h3 className="section-label">Raw Payload</h3><pre className="raw-json">{JSON.stringify(node.payload, null, 2)}</pre></section>
  </div>
}

function MessageBubble({ node, inspect }: { node: ReviewMessageNodeDto; inspect(node: ReviewNodeDto): void }) {
  const [expanded, setExpanded] = useState(false)
  const collapsible = node.text.length > 520 || node.text.split('\n').length > 7

  if (node.role === 'reasoning') {
    return <details className="thinking-block">
      <summary><span>Thinking</span><span>{formatClock(node.at)}</span></summary>
      <div className="markdown px-4 pb-3 pt-1 text-sm text-muted"><ReactMarkdown>{node.text}</ReactMarkdown></div>
      {node.evidence.length > 0 && <button className="mx-4 mb-3 text-xs text-muted hover:text-accent" onClick={() => inspect(node)}>证据 · {node.evidence.length}</button>}
    </details>
  }

  const user = node.role === 'user'
  return <div className={`chat-row ${user ? 'chat-row-user' : 'chat-row-agent'}`}>
    <div className={`chat-avatar ${user ? 'chat-avatar-user' : 'chat-avatar-agent'}`}>{user ? '你' : 'AI'}</div>
    <div className={`chat-bubble ${user ? 'chat-bubble-user' : 'chat-bubble-agent'}`}>
      <div className="chat-meta"><span>{user ? '用户' : 'Agent'}</span><time>{formatClock(node.at)}</time></div>
      <div className={`markdown chat-content ${collapsible && !expanded ? 'chat-content-collapsed' : ''}`}><ReactMarkdown>{node.text}</ReactMarkdown></div>
      <div className="mt-2 flex items-center gap-3">
        {collapsible && <button className="text-xs font-medium text-accent" onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开全文'}</button>}
        {node.evidence.length > 0 && <button className="text-xs text-muted hover:text-accent" onClick={() => inspect(node)}>证据 · {node.evidence.length}</button>}
      </div>
    </div>
  </div>
}

function ToolRow({ node, inspect, last }: { node: ReviewToolNodeDto; inspect(node: ReviewNodeDto): void; last: boolean }) {
  const status = node.status === 'error' ? 'error' : node.status === 'success' ? 'success' : node.status === 'running' ? 'running' : 'unknown'
  const input = brief(node.input, 110)
  const output = brief(node.output, 110)
  return <button className="execution-row" data-status={status} onClick={() => inspect(node)}>
    <span className="execution-rail" aria-hidden="true"><span className="execution-dot"/>{!last && <span className="execution-line"/>}</span>
    <span className="min-w-0 flex-1 py-2">
      <span className="flex items-center gap-2"><b className="font-mono text-xs">{node.name}</b><span className="tool-status-label">{node.status === 'error' ? '失败' : node.status === 'success' ? '完成' : node.status === 'running' ? '执行中' : '未知'}</span></span>
      {input && <span className="mt-1 block truncate text-xs text-muted">输入 · {input}</span>}
      {output && <span className={`mt-1 block truncate text-xs ${node.status === 'error' ? 'text-danger' : 'text-muted'}`}>结果 · {output}</span>}
    </span>
    <span className="pt-2 text-xs text-muted">{node.durationMs !== undefined ? duration(node.durationMs) : formatClock(node.at)}</span>
  </button>
}

function ToolRunGroup({ items, inspect }: { items: ReviewToolNodeDto[]; inspect(node: ReviewNodeDto): void }) {
  const errors = items.filter(item => item.status === 'error').length
  const totalDuration = items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
  const names = [...new Set(items.map(item => item.name))]
  return <details className={`execution-group ${errors ? 'execution-group-error' : ''}`} open={errors > 0}>
    <summary>
      <span className="execution-group-icon">⌁</span>
      <span className="min-w-0 flex-1"><b>执行过程</b><span className="ml-2 text-xs font-normal text-muted">{items.length} 次工具调用 · {names.slice(0, 3).join(' / ')}{names.length > 3 ? ' …' : ''}</span></span>
      <span className={`execution-summary-status ${errors ? 'text-danger' : 'text-success'}`}>{errors ? `${errors} 错误` : '成功'}</span>
      {totalDuration > 0 && <span className="text-xs text-muted">{duration(totalDuration)}</span>}
    </summary>
    <div className="execution-list">{items.map((node, index) => <ToolRow key={node.id} node={node} inspect={inspect} last={index === items.length - 1}/>)}</div>
  </details>
}

function EventRow({ event, inspect }: { event: ReviewEventNodeDto; inspect(node: ReviewNodeDto): void }) {
  return <button className={`event-row event-${event.category}`} onClick={() => inspect(event)}>
    <span className={`size-1.5 rounded-full ${sourceDot(event.sourceId)}`}/>
    <span className="font-medium">{sourceEventLabel(event)}</span>
    <span className="ml-auto text-xs text-muted">{formatClock(event.at)}</span>
  </button>
}

function Interaction({ ordinal, trigger, nodes, inspect }: { ordinal: number; trigger: 'user' | 'background'; nodes: ReviewNodeDto[]; inspect(node: ReviewNodeDto): void }) {
  const groups = useMemo(() => {
    const result: Array<ReviewNodeDto | { type: 'tool-group'; items: ReviewToolNodeDto[] }> = []
    let tools: ReviewToolNodeDto[] = []
    const flush = () => { if (tools.length) { result.push({ type: 'tool-group', items: tools }); tools = [] } }
    for (const node of nodes) {
      if (node.type === 'tool') { tools.push(node); continue }
      flush()
      result.push(node)
    }
    flush()
    return result
  }, [nodes])

  return <section className="interaction-block">
    <div className="interaction-separator"><span>{trigger === 'background' ? '后台活动' : `第 ${ordinal} 轮`}</span><i/></div>
    <div className="interaction-flow">{groups.map((entry, index) => {
      if (entry.type === 'tool-group') return <ToolRunGroup key={`tools-${index}`} items={entry.items} inspect={inspect}/>
      if (entry.type === 'message') return <MessageBubble key={entry.id} node={entry} inspect={inspect}/>
      return <EventRow key={entry.id} event={entry as ReviewEventNodeDto} inspect={inspect}/>
    })}</div>
  </section>
}

function Metric({ value, label, tone = '' }: { value: string | number; label: string; tone?: 'success' | 'danger' | '' }) {
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

  return <main className="mx-auto flex h-[calc(100vh-3.5rem)] max-w-[1800px] flex-col">
    <div className="toolbar">
      <AgentScope agents={agents} value={review.filters.sourceId} onChange={sourceId => model.setReviewFilters({ sourceId })}/>
      <div className="toolbar-divider"/>
      <select className="filter" value={review.filters.projectId} onChange={e => model.setReviewFilters({ projectId: e.target.value })}><option value="">全部项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name ?? p.repositoryIdentity ?? p.id}</option>)}</select>
      <select className="filter" value={review.filters.range} onChange={e => model.setReviewFilters({ range: e.target.value as typeof review.filters.range })}><option value="today">今天</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="all">全部时间</option></select>
      <select className="filter" value={review.filters.status} onChange={e => model.setReviewFilters({ status: e.target.value as typeof review.filters.status })}><option value="all">全部状态</option><option value="clean">无错误</option><option value="with-errors">有错误</option></select>
      <input className="filter ml-auto w-56" placeholder="搜索任务…" value={review.filters.search} onChange={e => model.setReviewFilters({ search: e.target.value })}/>
      <button className="icon-button" onClick={() => void model.refreshReview()} title="刷新">↻</button>
    </div>

    <div className="min-h-0 flex-1 md:grid md:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="session-list border-r border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-4 py-3"><span className="text-sm font-semibold">Sessions</span><span className="text-xs text-muted">{review.response?.items.length ?? 0}</span></div>
        <div className="overflow-y-auto">
          {review.loading && !review.response && <div className="empty">加载 Session…</div>}
          {review.response?.items.map(item => <button key={item.id} className={`session-item ${review.selectedId === item.id ? 'session-item-active' : ''}`} onClick={() => select(item.id)}>
            <div className="flex items-center gap-2"><span className={`size-2 rounded-full ${sourceDot(item.sourceIds[0] ?? '')}`}/><span className="text-xs font-medium">{agentLabel(item.sourceIds[0] ?? '', item.productId)}</span><span className="ml-auto text-[11px] text-muted">{formatTime(item.endedAt)}</span></div>
            <div className="mt-2 line-clamp-2 text-sm font-semibold leading-5">{item.title ?? item.preview ?? item.projectName ?? '未命名 Session'}</div>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted"><span className="truncate">{item.projectName ?? item.workspacePath?.split(/[\\/]/).pop() ?? '无项目'}</span><span className="ml-auto">{item.toolCount} 调用</span>{item.errorCount > 0 && <span className="text-danger">{item.errorCount} 错误</span>}</div>
          </button>)}
        </div>
      </aside>

      <section className="min-w-0 overflow-y-auto bg-canvas">
        {review.error && <div className="m-5 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{review.error}</div>}
        {!review.detail ? <div className="empty h-full">选择一个 Session 开始复盘</div> : <div className="mx-auto max-w-5xl px-7 py-6">
          <header className="review-session-head">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted"><span className={`size-2 rounded-full ${sourceDot(review.detail.sourceIds[0] ?? '')}`}/><span className="font-medium text-ink">{review.detail.sourceIds.map(id => agentLabel(id)).join(' / ')}</span><span>·</span><span>{review.detail.projectName ?? review.detail.workspacePath ?? '无项目'}</span>{review.detail.errorCount > 0 && <span className="session-status-error">有错误</span>}</div>
              <h1 className="mt-2 text-xl font-semibold leading-7">{review.detail.title ?? review.detail.preview ?? 'Session 复盘'}</h1>
              <div className="mt-2 text-xs text-muted">{formatRange(review.detail.startedAt, review.detail.endedAt)}</div>
            </div>
            <div className="review-metrics">
              <Metric value={review.detail.toolCount} label="调用"/>
              <Metric value={Math.max(review.detail.toolCount - review.detail.errorCount, 0)} label="成功" tone="success"/>
              {review.detail.errorCount > 0 && <Metric value={review.detail.errorCount} label="错误" tone="danger"/>}
              <Metric value={duration(review.detail.durationMs)} label="总耗时"/>
            </div>
          </header>

          {review.detail.sourceIds.includes('pi') && review.relationships?.items.length ? <details className="pi-session-tree mb-5">
            <summary>Pi Session Tree · {review.relationships.items.length} 条关系</summary>
            <div>{review.relationships.items.map(item => <div key={item.id} className="font-mono text-xs text-muted">{item.fromNativeSessionId ?? item.fromSessionId} <span className="px-2">→</span> {item.toNativeSessionId ?? item.toSessionId}</div>)}</div>
          </details> : null}

          <div className="space-y-2">{review.detail.interactions.map(interaction => <Interaction key={interaction.id} ordinal={interaction.ordinal} trigger={interaction.trigger} nodes={interaction.nodes} inspect={setInspect}/>)}</div>
        </div>}
      </section>
    </div>
    {inspect && <Inspector node={inspect} onClose={() => setInspect(null)}/>} 
  </main>
}
