import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useNavigate, useParams } from 'react-router-dom'
import type {
  JsonValue,
  ReviewEventNodeDto,
  ReviewInteractionDto,
  ReviewMessageNodeDto,
  ReviewNodeDto,
  ReviewToolNodeDto,
  TimelineEvidenceDto,
} from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentScope, agentLabel, sourceDot } from '../components/AgentScope'

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatClock(value: string): string {
  if (!value) return ''
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
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`
  if (value < 86_400_000) {
    const hours = value / 3_600_000
    return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}h`
  }
  const days = value / 86_400_000
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}天`
}

function elapsed(start: string, end: string): number {
  const value = Date.parse(end) - Date.parse(start)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function compactTitle(value: string | undefined, max = 92): string {
  const text = value?.replace(/\s+/g, ' ').trim() ?? ''
  if (!text) return '未命名会话'
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function payloadRecord(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}
}

function jsonString(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}

function brief(value: unknown, max = 120): string {
  const normalized = jsonString(value).replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized
}

function stringValue(record: Record<string, JsonValue>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function numberValue(record: Record<string, JsonValue>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

const evidenceCaptureLabel: Record<TimelineEvidenceDto['captureMethod'], string> = {
  'runtime-hook': '运行时捕获',
  'native-log': '原生日志',
  'native-db': '原生数据库',
  'static-scan': '静态发现',
  'external-import': '外部导入',
}

function EvidenceBadges({ evidence, compact = false }: { evidence: TimelineEvidenceDto[]; compact?: boolean }) {
  const visible = useMemo(() => {
    const seen = new Set<string>()
    const items: Array<{ key: string; label: string; confidence: string; title: string }> = []
    for (const item of evidence) {
      const key = `${item.captureMethod}:${item.derivation}:${item.confidence}`
      if (seen.has(key)) continue
      seen.add(key)
      const derivation = item.derivation === 'inferred' ? '推断' : item.derivation === 'estimated' ? '估算' : ''
      const label = derivation || evidenceCaptureLabel[item.captureMethod]
      items.push({
        key,
        label,
        confidence: item.confidence,
        title: [evidenceCaptureLabel[item.captureMethod], `来源：${item.derivation}`, `可信度：${item.confidence}`, item.missingReason ?? ''].filter(Boolean).join(' · '),
      })
    }
    return items.slice(0, compact ? 1 : 2)
  }, [evidence, compact])

  if (!visible.length) return null
  return <span className="evidence-inline-list">
    {visible.map(item => <span key={item.key} className="evidence-inline" data-confidence={item.confidence} title={item.title}>{item.label}</span>)}
    {evidence.length > visible.length && !compact && <span className="evidence-inline-more">+{evidence.length - visible.length}</span>}
  </span>
}

function sourceEventLabel(node: ReviewEventNodeDto): string {
  const payload = payloadRecord(node.payload)
  const action = stringValue(payload, 'action', 'event', 'type', 'status').toLowerCase()
  if (node.sourceId === 'codex') {
    if (node.kind === 'context.compaction') return '上下文压缩'
    if (node.kind === 'subagent.spawn') return '启动 Subagent'
    if (node.kind === 'subagent.end') return 'Subagent 完成'
    if (node.kind === 'permission.request') return '权限请求'
    if (node.kind === 'session.lifecycle' && action.includes('stop')) return 'Turn Stop'
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

function sourceEventSummary(node: ReviewEventNodeDto): string {
  const payload = payloadRecord(node.payload)
  const action = stringValue(payload, 'action', 'event', 'type', 'status')
  if (node.kind === 'model.changed' || node.kind === 'model.call') {
    const model = stringValue(payload, 'model', 'modelName', 'model_name')
    const provider = stringValue(payload, 'provider', 'modelProvider', 'model_provider')
    return [provider, model].filter(Boolean).join(' / ') || brief(payload, 100)
  }
  if (node.kind === 'permission.request' || node.kind === 'permission.response') {
    const tool = stringValue(payload, 'toolName', 'tool_name', 'tool', 'name')
    const decision = stringValue(payload, 'decision', 'result', 'permissionMode', 'permission_mode')
    return [tool, decision].filter(Boolean).join(' · ') || brief(payload, 100)
  }
  if (node.kind === 'subagent.spawn' || node.kind === 'subagent.end') {
    const type = stringValue(payload, 'agentType', 'agent_type', 'subagentType', 'subagent_type', 'name')
    const agentId = stringValue(payload, 'agentId', 'agent_id', 'subagentId', 'subagent_id')
    return [type, agentId ? `Agent ${agentId}` : ''].filter(Boolean).join(' · ') || brief(payload, 100)
  }
  if (node.kind === 'context.compaction') {
    const trigger = stringValue(payload, 'trigger', 'compactTrigger', 'compact_trigger', 'reason', 'compactReason', 'compact_reason')
    const before = numberValue(payload, 'tokensBefore', 'tokens_before')
    return [trigger ? `触发：${trigger}` : '', before !== undefined ? `压缩前 ${before.toLocaleString()} tokens` : ''].filter(Boolean).join(' · ') || brief(payload, 100)
  }
  if (node.kind === 'context.summary') {
    return brief(payload.summary ?? payload.text ?? payload.content ?? payload, 120)
  }
  if (node.kind === 'session.lifecycle') {
    const startSource = stringValue(payload, 'startSource', 'start_source', 'source')
    const reason = stringValue(payload, 'reason', 'lifecycleReason', 'lifecycle_reason', 'stopReason', 'stop_reason')
    const model = stringValue(payload, 'model')
    return [action, startSource ? `来源 ${startSource}` : '', reason ? `原因 ${reason}` : '', model].filter(Boolean).join(' · ') || brief(payload, 100)
  }
  if (node.kind === 'usage') {
    const input = numberValue(payload, 'inputTokens', 'input_tokens')
    const output = numberValue(payload, 'outputTokens', 'output_tokens')
    if (input !== undefined || output !== undefined) return `输入 ${input ?? 0} · 输出 ${output ?? 0} tokens`
  }
  if (node.kind === 'artifact.action') {
    const path = stringValue(payload, 'path', 'filePath', 'file_path')
    return [action, path].filter(Boolean).join(' · ') || brief(payload, 100)
  }
  return action || brief(payload, 100)
}

function isGenericRawEvent(node: ReviewEventNodeDto): boolean {
  if (node.category !== 'unknown') return false
  return /^(原始事件|raw event|event)$/i.test(sourceEventLabel(node).trim())
}

type ToolKind = 'shell' | 'read' | 'edit' | 'search' | 'mcp' | 'web' | 'tool'

function detectToolKind(name: string): ToolKind {
  const value = name.toLowerCase()
  if (/(bash|shell|exec|command|terminal|powershell|cmd)/.test(value)) return 'shell'
  if (/(read|cat|open[_-]?file|get[_-]?file|view[_-]?file)/.test(value)) return 'read'
  if (/(write|edit|patch|replace|create[_-]?file|apply[_-]?patch)/.test(value)) return 'edit'
  if (/(grep|search|find|glob|ripgrep|rg)/.test(value)) return 'search'
  if (value.includes('mcp')) return 'mcp'
  if (/(web|browser|fetch|http|url)/.test(value)) return 'web'
  return 'tool'
}

function toolInputRecord(node: ReviewToolNodeDto): Record<string, JsonValue> {
  return payloadRecord(node.input)
}

function toolPresentation(node: ReviewToolNodeDto): { kind: ToolKind; icon: string; label: string; primary: string; secondary: string } {
  const input = toolInputRecord(node)
  const kind = detectToolKind(node.name)
  const output = brief(node.output, 110)
  if (kind === 'shell') {
    const command = stringValue(input, 'command', 'cmd', 'script', 'raw') || brief(node.input, 140)
    return { kind, icon: '›_', label: '命令', primary: command, secondary: output }
  }
  if (kind === 'read') {
    const path = stringValue(input, 'path', 'file_path', 'filePath', 'filename') || brief(node.input, 120)
    return { kind, icon: 'R', label: '读取', primary: path, secondary: output }
  }
  if (kind === 'edit') {
    const path = stringValue(input, 'path', 'file_path', 'filePath', 'filename', 'new_path', 'old_path') || brief(node.input, 120)
    const patch = stringValue(input, 'patch', 'diff', 'content')
    return { kind, icon: 'E', label: '修改', primary: path, secondary: patch ? brief(patch, 110) : output }
  }
  if (kind === 'search') {
    const query = stringValue(input, 'query', 'pattern', 'search', 'glob') || brief(node.input, 120)
    const path = stringValue(input, 'path', 'cwd', 'directory')
    return { kind, icon: '⌕', label: '搜索', primary: query, secondary: path || output }
  }
  if (kind === 'mcp') {
    const target = stringValue(input, 'tool', 'server', 'mcp_server', 'name', 'method') || brief(node.input, 120)
    return { kind, icon: 'M', label: 'MCP', primary: target, secondary: output }
  }
  if (kind === 'web') {
    const target = stringValue(input, 'url', 'query', 'href', 'path') || brief(node.input, 120)
    return { kind, icon: '↗', label: '网络', primary: target, secondary: output }
  }
  return { kind, icon: '◇', label: '工具', primary: brief(node.input, 130), secondary: output }
}

function PrettyJson({ value }: { value: unknown }) {
  if (value === undefined) return <div className="muted-empty compact">无数据</div>
  if (typeof value === 'string') return <pre className="tool-detail-code">{value}</pre>
  return <pre className="tool-detail-code">{JSON.stringify(value, null, 2)}</pre>
}

function StructuredToolDetail({ node }: { node: ReviewToolNodeDto }) {
  const info = toolPresentation(node)
  const input = toolInputRecord(node)
  const primaryLabel = info.kind === 'shell' ? '命令' : info.kind === 'read' || info.kind === 'edit' ? '路径' : info.kind === 'search' ? '查询' : info.kind === 'mcp' ? '目标' : info.kind === 'web' ? '地址 / 查询' : '输入摘要'
  const status = node.status === 'error' ? '失败' : node.status === 'success' ? '完成' : node.status === 'running' ? '执行中' : '未知'
  return <section className="tool-detail">
    <div className="tool-detail-summary">
      <span className={`tool-detail-icon tool-kind-${info.kind}`}>{info.icon}</span>
      <div><b>{node.name}</b><span>{info.label} · {status}{node.durationMs !== undefined ? ` · ${duration(node.durationMs)}` : ''}</span></div>
    </div>
    {info.primary && <div className="tool-detail-section"><h4>{primaryLabel}</h4><pre className="tool-detail-code">{info.primary}</pre></div>}
    {Object.keys(input).length > 0 && <div className="tool-detail-section"><h4>结构化输入</h4><PrettyJson value={node.input}/></div>}
    {node.output !== undefined && <div className={`tool-detail-section ${node.status === 'error' ? 'is-error' : ''}`}><h4>{node.status === 'error' ? '错误 / 输出' : '输出'}</h4><PrettyJson value={node.output}/></div>}
  </section>
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
    {node.type === 'tool' && <StructuredToolDetail node={node}/>} 
    <section className="inspector-section">
      <h3 className="section-label">Evidence</h3>
      {node.evidence.length ? node.evidence.map(item => <div key={item.id} className="evidence-card">
        <div className="evidence-meta"><b>{evidenceCaptureLabel[item.captureMethod]}</b><span>{item.derivation}</span><span>{item.confidence}</span></div>
        <div className="evidence-path">{item.sourceLocator?.path ?? item.sourceRecordId ?? item.id}</div>
        {item.missingReason && <div className="evidence-missing">{item.missingReason}</div>}
      </div>) : <div className="muted-empty">无 Evidence</div>}
    </section>
    <section className="inspector-section"><h3 className="section-label">Raw Payload</h3><pre className="raw-json">{JSON.stringify(node.payload, null, 2)}</pre></section>
  </aside>
}

function MarkdownSurface({ text }: { text: string }) {
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)
  const [collapsedHeight, setCollapsedHeight] = useState<number | undefined>()
  const surfaceRef = useRef<HTMLDivElement>(null)

  const measure = useCallback(() => {
    const element = surfaceRef.current
    if (!element) return
    const style = window.getComputedStyle(element)
    const fontSize = Number.parseFloat(style.fontSize) || 14
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.65
    const limit = Math.ceil(lineHeight * 5 + 2)
    setCollapsedHeight(limit)
    setCollapsible(element.scrollHeight > limit + 2)
  }, [])

  useLayoutEffect(() => {
    setExpanded(false)
    const element = surfaceRef.current
    if (!element) return
    const frame = window.requestAnimationFrame(measure)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(element)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [measure, text, view])

  return <div className="markdown-message" data-view={view}>
    <div
      ref={surfaceRef}
      className={`markdown-surface ${collapsible && !expanded ? 'is-collapsed' : ''}`}
      style={collapsible && !expanded && collapsedHeight ? { maxHeight: `${collapsedHeight}px` } : undefined}
    >
      {view === 'rendered' ? <div className="markdown"><ReactMarkdown>{text}</ReactMarkdown></div> : <pre className="markdown-source">{text}</pre>}
      {collapsible && !expanded && <span className="markdown-fade" aria-hidden="true"/>}
    </div>
    <div className="markdown-message-actions">
      {collapsible && <button onClick={() => setExpanded(value => !value)}>{expanded ? '收起到 5 行' : '展开全文'}</button>}
      <button onClick={() => setView(value => value === 'rendered' ? 'source' : 'rendered')}>{view === 'rendered' ? '查看源码' : 'Markdown 渲染'}</button>
    </div>
  </div>
}

function MessageBubble({ node, inspect }: { node: ReviewMessageNodeDto; inspect(node: ReviewNodeDto): void }) {
  if (node.role === 'reasoning') {
    return <details className="thinking-block">
      <summary>
        <span className="thinking-label">Thinking</span>
        <span className="thinking-preview">{brief(node.text, 78)}</span>
        <EvidenceBadges evidence={node.evidence} compact/>
        <time>{formatClock(node.at)}</time>
      </summary>
      <div className="thinking-content"><MarkdownSurface text={node.text}/></div>
      {node.evidence.length > 0 && <button className="evidence-link" onClick={() => inspect(node)}>查看全部证据 · {node.evidence.length}</button>}
    </details>
  }

  const user = node.role === 'user'
  return <div className={`chat-row ${user ? 'chat-row-user' : 'chat-row-agent'}`}>
    <div className={`chat-avatar ${user ? 'chat-avatar-user' : 'chat-avatar-agent'}`}>{user ? '你' : 'AI'}</div>
    <div className={`chat-bubble ${user ? 'chat-bubble-user' : 'chat-bubble-agent'}`}>
      <div className="chat-meta"><span>{user ? '你' : 'Agent'}</span><EvidenceBadges evidence={node.evidence}/><time>{formatClock(node.at)}</time></div>
      <MarkdownSurface text={node.text}/>
      {node.evidence.length > 0 && <div className="chat-actions"><button onClick={() => inspect(node)}>证据详情 · {node.evidence.length}</button></div>}
    </div>
  </div>
}

function ToolRow({ node, inspect, last }: { node: ReviewToolNodeDto; inspect(node: ReviewNodeDto): void; last: boolean }) {
  const status = node.status === 'error' ? 'error' : node.status === 'success' ? 'success' : node.status === 'running' ? 'running' : 'unknown'
  const info = toolPresentation(node)
  return <button className="execution-row" data-status={status} data-kind={info.kind} onClick={() => inspect(node)}>
    <span className="execution-rail" aria-hidden="true"><span className="execution-dot"/>{!last && <span className="execution-line"/>}</span>
    <span className={`execution-tool-icon tool-kind-${info.kind}`}>{info.icon}</span>
    <span className="execution-main">
      <span className="execution-name"><b>{node.name}</b><span className="tool-kind-label">{info.label}</span><span className="tool-status-label">{node.status === 'error' ? '失败' : node.status === 'success' ? '完成' : node.status === 'running' ? '执行中' : '未知'}</span><EvidenceBadges evidence={node.evidence} compact/></span>
      {info.primary && <span className="execution-preview execution-primary">{info.primary}</span>}
      {info.secondary && <span className={`execution-preview ${node.status === 'error' ? 'execution-preview-error' : ''}`}>{info.secondary}</span>}
    </span>
    <span className="execution-duration">{node.durationMs !== undefined ? duration(node.durationMs) : formatClock(node.at)}</span>
  </button>
}

function ToolRunGroup({ items, inspect }: { items: ReviewToolNodeDto[]; inspect(node: ReviewNodeDto): void }) {
  const errors = items.filter(item => item.status === 'error').length
  const [expanded, setExpanded] = useState(errors > 0)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const totalDuration = items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
  const typeCounts = useMemo(() => {
    const counts = new Map<ToolKind, number>()
    for (const item of items) {
      const kind = detectToolKind(item.name)
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  }, [items])
  const visible = errorsOnly ? items.filter(item => item.status === 'error') : items
  return <details className={`execution-group ${errors ? 'execution-group-error' : ''}`} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>
      <span className="execution-group-icon">↳</span>
      <span className="execution-group-copy"><b>工具执行</b><small>{items.length} 次调用</small></span>
      <span className="execution-kind-counts">{typeCounts.map(([kind, count]) => <span key={kind}>{kind} {count}</span>)}</span>
      <span className={`execution-summary-status ${errors ? 'is-error' : 'is-ok'}`}>{errors ? `${errors} 个错误` : '全部完成'}</span>
      {totalDuration > 0 && <span className="execution-total">{duration(totalDuration)}</span>}
    </summary>
    <div className="execution-group-toolbar">
      <span>共 {items.length} 次 · {errors} 次失败</span>
      {errors > 0 && <label><input type="checkbox" checked={errorsOnly} onChange={event => setErrorsOnly(event.target.checked)}/> 只看错误</label>}
    </div>
    <div className="execution-list">{visible.map((node, index) => <ToolRow key={node.id} node={node} inspect={inspect} last={index === visible.length - 1}/>)}</div>
  </details>
}

function EventRow({ event, inspect }: { event: ReviewEventNodeDto; inspect(node: ReviewNodeDto): void }) {
  const summary = sourceEventSummary(event)
  return <button className={`event-row event-${event.category}`} onClick={() => inspect(event)}>
    <span className="event-mark" />
    <span className="event-copy"><b>{sourceEventLabel(event)}</b>{summary && <small>{summary}</small>}</span>
    <EvidenceBadges evidence={event.evidence} compact/>
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

interface InteractionStats {
  toolCount: number
  errorCount: number
  durationMs: number
  preview: string
}

function interactionStats(interaction: ReviewInteractionDto): InteractionStats {
  const tools = interaction.nodes.filter((node): node is ReviewToolNodeDto => node.type === 'tool')
  const user = interaction.nodes.find((node): node is ReviewMessageNodeDto => node.type === 'message' && node.role === 'user')
  return {
    toolCount: tools.length,
    errorCount: tools.filter(tool => tool.status === 'error').length,
    durationMs: elapsed(interaction.startedAt, interaction.endedAt),
    preview: brief(user?.text ?? '', 86),
  }
}

function Interaction({ interaction, inspect, highLatency, defaultExpanded }: { interaction: ReviewInteractionDto; inspect(node: ReviewNodeDto): void; highLatency: boolean; defaultExpanded: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const stats = useMemo(() => interactionStats(interaction), [interaction])
  const groups = useMemo(() => {
    const result: InteractionEntry[] = []
    let tools: ReviewToolNodeDto[] = []
    let rawEvents: ReviewEventNodeDto[] = []
    const flushTools = () => { if (tools.length) { result.push({ type: 'tool-group', items: tools }); tools = [] } }
    const flushRawEvents = () => { if (rawEvents.length) { result.push({ type: 'raw-event-group', items: rawEvents }); rawEvents = [] } }

    for (const node of interaction.nodes) {
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
  }, [interaction.nodes])

  return <details className={`interaction-block ${stats.errorCount ? 'interaction-has-error' : ''}`} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="interaction-summary">
      <span className="interaction-chevron">›</span>
      <span className="interaction-title">{interaction.trigger === 'background' ? '后台活动' : `第 ${interaction.ordinal} 轮`}</span>
      {stats.preview && <span className="interaction-preview">{stats.preview}</span>}
      <span className="interaction-summary-meta">
        {stats.toolCount > 0 && <span>{stats.toolCount} 工具</span>}
        {stats.errorCount > 0 && <span className="is-error">{stats.errorCount} 错误</span>}
        {highLatency && <span className="is-latency">高耗时</span>}
        {stats.durationMs > 0 && <span>{duration(stats.durationMs)}</span>}
      </span>
    </summary>
    <div className="interaction-flow">{groups.map((entry, index) => {
      if (entry.type === 'tool-group') return <ToolRunGroup key={`tools-${index}`} items={entry.items} inspect={inspect}/>
      if (entry.type === 'raw-event-group') return <RawEventGroup key={`raw-${index}`} items={entry.items} inspect={inspect}/>
      if (entry.type === 'message') return <MessageBubble key={entry.id} node={entry} inspect={inspect}/>
      return <EventRow key={entry.id} event={entry as ReviewEventNodeDto} inspect={inspect}/>
    })}</div>
  </details>
}

function Metric({ value, label, tone = '' }: { value: string | number; label: string; tone?: 'danger' | '' }) {
  return <div className="review-metric" data-tone={tone}><b>{value}</b><span>{label}</span></div>
}

type RoundFilter = 'all' | 'errors' | 'latency' | 'latest'

function highLatencyThreshold(interactions: ReviewInteractionDto[]): number | null {
  const values = interactions.map(item => elapsed(item.startedAt, item.endedAt)).filter(value => value > 0).sort((a, b) => a - b)
  if (values.length < 2) return null
  const middle = Math.floor(values.length / 2)
  const median = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2
  const upperIndex = Math.min(values.length - 1, Math.floor((values.length - 1) * 0.75))
  const upperQuartile = values[upperIndex]!
  return Math.max(upperQuartile, median * 1.75)
}

export function ReviewPage({ model }: { model: AgentLensClientModel }) {
  const snapshot = useClientSnapshot(model)
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [inspect, setInspect] = useState<ReviewNodeDto | null>(null)
  const [roundFilter, setRoundFilter] = useState<RoundFilter>('all')
  const review = snapshot.review
  const agents = snapshot.facets?.agents ?? []
  const projects = snapshot.facets?.projects ?? []
  const detail = review.detail

  useEffect(() => { if (sessionId && sessionId !== review.selectedId) void model.selectReviewSession(sessionId) }, [sessionId])
  useEffect(() => setRoundFilter('all'), [detail?.id])
  const select = (id: string) => { void model.selectReviewSession(id); navigate(`/review/${encodeURIComponent(id)}`) }

  const threshold = useMemo(() => detail ? highLatencyThreshold(detail.interactions) : null, [detail])
  const annotatedInteractions = useMemo(() => (detail?.interactions ?? []).map(interaction => {
    const stats = interactionStats(interaction)
    return { interaction, stats, highLatency: threshold !== null && stats.durationMs >= threshold }
  }), [detail, threshold])
  const errorRoundCount = annotatedInteractions.filter(item => item.stats.errorCount > 0).length
  const latencyRoundCount = annotatedInteractions.filter(item => item.highLatency).length
  const visibleInteractions = useMemo(() => {
    if (roundFilter === 'errors') return annotatedInteractions.filter(item => item.stats.errorCount > 0)
    if (roundFilter === 'latency') return annotatedInteractions.filter(item => item.highLatency)
    if (roundFilter === 'latest') return annotatedInteractions.slice(-1)
    return annotatedInteractions
  }, [annotatedInteractions, roundFilter])

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
        <div className="session-panel-head"><div><b>会话</b><span>按时间倒序</span></div><span className="count-badge">{review.response?.items.length ?? 0}{review.response?.meta.hasMore ? '+' : ''}</span></div>
        <div className="session-scroll">
          {review.loading && !review.response && <div className="empty-state">加载会话…</div>}
          {review.response?.items.map(item => <button key={item.id} className={`session-item ${review.selectedId === item.id ? 'session-item-active' : ''}`} onClick={() => select(item.id)}>
            <div className="session-item-meta"><span className={`source-dot ${sourceDot(item.sourceIds[0] ?? '')}`}/><span>{agentLabel(item.sourceIds[0] ?? '', item.productId)}</span><time>{formatTime(item.endedAt)}</time></div>
            <div className="session-item-title">{compactTitle(item.title ?? item.preview ?? item.projectName, 74)}</div>
            <div className="session-item-foot"><span>{item.projectName ?? item.workspacePath?.split(/[\\/]/).pop() ?? '无项目'}</span><span>{item.toolCount} 调用{item.errorCount > 0 ? ` · ${item.errorCount} 错误` : ''}</span></div>
          </button>)}
          {review.response?.meta.hasMore && <button className="session-load-more" disabled={review.loadingMore} onClick={() => void model.loadMoreReview()}>{review.loadingMore ? '加载中…' : `加载更多会话 · 再显示最多 40 条`}</button>}
          {!review.loading && !review.response?.items.length && <div className="empty-state">当前筛选范围没有会话</div>}
        </div>
      </aside>

      <section className="review-reader-pane">
        {review.error && <div className="page-error">{review.error}</div>}
        {!detail ? <div className="empty-state fill">选择一个会话开始复盘</div> : <div className="review-reader">
          <header className="review-session-head">
            <div className="review-session-copy">
              <div className="review-session-meta"><span className={`source-dot ${sourceDot(detail.sourceIds[0] ?? '')}`}/><b>{detail.sourceIds.map(id => agentLabel(id)).join(' / ')}</b><span>{detail.projectName ?? '无项目'}</span>{detail.errorCount > 0 && <span className="session-status-error">有错误</span>}</div>
              <h1 className="review-session-title" title={detail.title ?? detail.preview}>{compactTitle(detail.title ?? detail.preview)}</h1>
              <div className="review-session-submeta">
                <span>{formatRange(detail.startedAt, detail.endedAt)}</span>
                {detail.workspacePath && <code title={detail.workspacePath}>{detail.workspacePath}</code>}
              </div>
            </div>
            <div className="review-metrics">
              <Metric value={detail.interactionCount} label="轮次"/>
              <Metric value={detail.toolCount} label="调用"/>
              {detail.errorCount > 0 && <Metric value={detail.errorCount} label="错误" tone="danger"/>}
              <Metric value={duration(detail.durationMs)} label="跨度"/>
            </div>
          </header>

          {detail.sourceIds.includes('pi') && review.relationships?.items.length ? <details className="pi-session-tree">
            <summary>Pi Session Tree · {review.relationships.items.length} 条关系</summary>
            <div>{review.relationships.items.map(item => <div key={item.id}>{item.fromNativeSessionId ?? item.fromSessionId} <span>→</span> {item.toNativeSessionId ?? item.toSessionId}</div>)}</div>
          </details> : null}

          <div className="round-nav" aria-label="轮次快速导航">
            <button className={roundFilter === 'all' ? 'active' : ''} onClick={() => setRoundFilter('all')}>全部 <span>{annotatedInteractions.length}</span></button>
            <button className={roundFilter === 'errors' ? 'active' : ''} disabled={!errorRoundCount} onClick={() => setRoundFilter('errors')}>有错误 <span>{errorRoundCount}</span></button>
            <button className={roundFilter === 'latency' ? 'active' : ''} disabled={!latencyRoundCount} onClick={() => setRoundFilter('latency')}>高耗时 <span>{latencyRoundCount}</span></button>
            <button className={roundFilter === 'latest' ? 'active' : ''} disabled={!annotatedInteractions.length} onClick={() => setRoundFilter('latest')}>最近一轮</button>
            <small>“高耗时”按本会话轮次耗时分布自适应识别，不使用固定阈值。</small>
          </div>

          <div className="review-flow">
            {visibleInteractions.map((item, index) => <Interaction
              key={item.interaction.id}
              interaction={item.interaction}
              highLatency={item.highLatency}
              defaultExpanded={item.stats.errorCount > 0 || roundFilter !== 'all' || item.interaction.id === annotatedInteractions.at(-1)?.interaction.id || index === 0}
              inspect={setInspect}
            />)}
            {!visibleInteractions.length && <div className="round-filter-empty">当前筛选条件没有匹配的轮次。</div>}
          </div>
        </div>}
      </section>
    </div>
    {inspect && <Inspector node={inspect} onClose={() => setInspect(null)}/>} 
  </main>
}
