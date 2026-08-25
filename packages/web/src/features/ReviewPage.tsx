import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useNavigate, useParams } from 'react-router-dom'
import type {
  JsonValue,
  ReviewDetailFilter,
  ReviewEventNodeDto,
  ReviewInteractionDto,
  ReviewMessageNodeDto,
  ReviewNodeDto,
  ReviewSessionSummaryDto,
  ReviewToolNodeDto,
  TimelineEvidenceDto,
} from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { useClientSnapshot } from '../App'
import { AgentScope, agentLabel, sourceDot } from '../components/AgentScope'
import { ToolKindIcon } from '../components/ToolKindIcon'
import { VirtualRoundMount } from '../components/VirtualRoundMount'

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatClock(value: string): string {
  if (!value) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value))
}

function formatHourMinute(value: string): string {
  if (!value) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

function formatRange(start: string, end: string): string {
  const left = new Date(start)
  const right = new Date(end)
  const sameDay = left.toDateString() === right.toDateString()
  const date = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(left)
  return sameDay ? `${date} ${formatClock(start)} – ${formatClock(end)}` : `${formatTime(start)} – ${formatTime(end)}`
}

function localDayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
}

function sessionDayLabel(value: string, now = new Date()): '今天' | '昨天' | '更早' {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '更早'
  const day = localDayStart(date)
  const today = localDayStart(now)
  if (day === today) return '今天'
  if (day === today - 86_400_000) return '昨天'
  return '更早'
}

function sessionRelativeTime(value: string, now = new Date()): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  const group = sessionDayLabel(value, now)
  if (group === '今天') {
    const diff = Math.max(0, now.getTime() - date.getTime())
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.floor(diff / 3_600_000)
    if (hours <= 1) return '约 1 小时前'
    return `${hours} 小时前`
  }
  if (group === '昨天') return `昨天 ${formatHourMinute(value)}`
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${formatHourMinute(value)}`
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function duration(ms: number): string {
  const value = Math.max(0, ms)
  if (value < 1000) return `${value} 毫秒`
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} 秒`
  if (value < 3_600_000) return `${Math.round(value / 60_000)} 分钟`
  if (value < 86_400_000) {
    const hours = value / 3_600_000
    return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} 小时`
  }
  const days = value / 86_400_000
  return `${days < 10 ? days.toFixed(1) : Math.round(days)} 天`
}

function elapsed(start: string, end: string): number {
  const value = Date.parse(end) - Date.parse(start)
  return Number.isFinite(value) && value > 0 ? value : 0
}

const injectedTitlePatterns = [
  /<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi,
  /# AGENTS\.md instructions[^\n]*[\s\S]*?<\/INSTRUCTIONS>/gi,
  /<environment_context>[\s\S]*?<\/environment_context>/gi,
  /<app-context>[\s\S]*?<\/app-context>/gi,
  /<skills_instructions>[\s\S]*?<\/skills_instructions>/gi,
  /<permissions instructions>[\s\S]*?<\/permissions instructions>/gi,
  /<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi,
]

function cleanSessionTitle(value: string | undefined): string {
  let text = value?.trim() ?? ''
  for (const pattern of injectedTitlePatterns) text = text.replace(pattern, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  if (/^(?:<recommended_plugins>|# AGENTS\.md instructions|<environment_context>)/i.test(text)) return ''
  return text
}

function compactTitle(value: string | undefined, max = 92, fallback = '未命名会话'): string {
  const text = cleanSessionTitle(value)
  if (!text) return fallback
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function sessionTitle(candidates: Array<string | undefined>, fallback: string, max = 92): string {
  const value = candidates.find(candidate => cleanSessionTitle(candidate))
  return compactTitle(value, max, fallback)
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

const evidenceDerivationLabel: Record<string, string> = {
  observed: '已观测',
  reported: '来源报告',
  derived: '推导',
  estimated: '估算',
  inferred: '推断',
}

const evidenceConfidenceLabel: Record<string, string> = {
  exact: '精确',
  high: '高',
  medium: '中',
  low: '低',
  unknown: '未知',
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
        title: [
          evidenceCaptureLabel[item.captureMethod],
          `来源：${evidenceDerivationLabel[item.derivation] ?? item.derivation}`,
          `可信度：${evidenceConfidenceLabel[item.confidence] ?? item.confidence}`,
          item.missingReason ? '证据信息不完整' : '',
        ].filter(Boolean).join(' · '),
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
    if (node.kind === 'subagent.spawn') return '启动子智能体'
    if (node.kind === 'subagent.end') return '子智能体完成'
    if (node.kind === 'permission.request') return '权限请求'
    if (node.kind === 'session.lifecycle' && action.includes('stop')) return '轮次停止'
  }
  if (node.sourceId === 'claude-code') {
    if (node.kind === 'permission.request') return '权限请求'
    if (node.kind === 'subagent.spawn') return '启动子智能体'
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
    return [type, agentId ? `子智能体 ${agentId}` : ''].filter(Boolean).join(' · ') || brief(payload, 100)
  }
  if (node.kind === 'context.compaction') {
    const trigger = stringValue(payload, 'trigger', 'compactTrigger', 'compact_trigger', 'reason', 'compactReason', 'compact_reason')
    const before = numberValue(payload, 'tokensBefore', 'tokens_before')
    return [trigger ? `触发：${trigger}` : '', before !== undefined ? `压缩前 ${before.toLocaleString()} 个词元` : ''].filter(Boolean).join(' · ') || brief(payload, 100)
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
    if (input !== undefined || output !== undefined) return `输入 ${input ?? 0} · 输出 ${output ?? 0} 个词元`
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
  if (value.includes('mcp')) return 'mcp'
  if (/(web|browser|http|url)/.test(value)) return 'web'
  if (/(bash|shell|exec|command|terminal|powershell|cmd)/.test(value)) return 'shell'
  if (/(read|cat|open[_-]?file|get[_-]?file|view[_-]?file)/.test(value)) return 'read'
  if (/(write|edit|patch|replace|create[_-]?file|apply[_-]?patch)/.test(value)) return 'edit'
  if (/(grep|search|find|glob|ripgrep|rg)/.test(value)) return 'search'
  return 'tool'
}

function toolKindLabel(kind: ToolKind): string {
  if (kind === 'shell') return '命令'
  if (kind === 'read') return '读取'
  if (kind === 'edit') return '修改'
  if (kind === 'search') return '搜索'
  if (kind === 'mcp') return 'MCP（模型上下文协议）'
  if (kind === 'web') return '网络'
  return '工具'
}

function toolInputRecord(node: ReviewToolNodeDto): Record<string, JsonValue> {
  return payloadRecord(node.input)
}

function toolPresentation(node: ReviewToolNodeDto): { kind: ToolKind; label: string; primary: string; secondary: string } {
  const input = toolInputRecord(node)
  const kind = detectToolKind(node.name)
  const output = brief(node.output, 110)
  if (kind === 'shell') {
    const command = stringValue(input, 'command', 'cmd', 'script', 'raw') || brief(node.input, 140)
    return { kind, label: '命令', primary: command, secondary: output }
  }
  if (kind === 'read') {
    const path = stringValue(input, 'path', 'file_path', 'filePath', 'filename') || brief(node.input, 120)
    return { kind, label: '读取', primary: path, secondary: output }
  }
  if (kind === 'edit') {
    const path = stringValue(input, 'path', 'file_path', 'filePath', 'filename', 'new_path', 'old_path') || brief(node.input, 120)
    const patch = stringValue(input, 'patch', 'diff', 'content')
    return { kind, label: '修改', primary: path, secondary: patch ? brief(patch, 110) : output }
  }
  if (kind === 'search') {
    const query = stringValue(input, 'query', 'pattern', 'search', 'glob') || brief(node.input, 120)
    const path = stringValue(input, 'path', 'cwd', 'directory')
    return { kind, label: '搜索', primary: query, secondary: path || output }
  }
  if (kind === 'mcp') {
    const target = stringValue(input, 'tool', 'server', 'mcp_server', 'name', 'method') || brief(node.input, 120)
    return { kind, label: 'MCP（模型上下文协议）', primary: target, secondary: output }
  }
  if (kind === 'web') {
    const target = stringValue(input, 'url', 'query', 'href', 'path') || brief(node.input, 120)
    return { kind, label: '网络', primary: target, secondary: output }
  }
  return { kind, label: '工具', primary: brief(node.input, 130), secondary: output }
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
      <span className={`tool-detail-icon tool-kind-${info.kind}`}><ToolKindIcon kind={info.kind}/></span>
      <div><b>{node.name}</b><span>{info.label} · {status}{node.durationMs !== undefined && node.durationMs > 0 ? ` · ${duration(node.durationMs)}` : ''}</span></div>
    </div>
    {info.primary && <div className="tool-detail-section"><h4>{primaryLabel}</h4><pre className="tool-detail-code">{info.primary}</pre></div>}
    {Object.keys(input).length > 0 && <div className="tool-detail-section"><h4>结构化输入</h4><PrettyJson value={node.input}/></div>}
    {node.output !== undefined && <div className={`tool-detail-section ${node.status === 'error' ? 'is-error' : ''}`}><h4>{node.status === 'error' ? '错误 / 输出' : '输出'}</h4><PrettyJson value={node.output}/></div>}
  </section>
}

function roleLabel(role: ReviewMessageNodeDto['role']): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return '智能体'
  return '可观察过程片段'
}

type InspectorTab = 'detail' | 'evidence' | 'raw'

function Inspector({ node, onClose }: { node: ReviewNodeDto; onClose(): void }) {
  const [tab, setTab] = useState<InspectorTab>('detail')
  const panelRef = useRef<HTMLElement>(null)
  const firstTabRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    firstTabRef.current?.focus()
    const panel = panelRef.current
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !panel) return
      const focusable = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (!focusable.length) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.requestAnimationFrame(() => returnFocusRef.current?.focus())
    }
  }, [])

  const title = node.type === 'tool' ? node.name : node.type === 'event' ? sourceEventLabel(node) : roleLabel(node.role)
  const detailSummary = node.type === 'event'
    ? sourceEventSummary(node)
    : node.type === 'message'
      ? brief(node.text, 280)
      : ''

  return <aside ref={panelRef} className="inspector-panel" role="dialog" aria-modal="true" aria-label={`${title}详情`}>
    <div className="inspector-head">
      <div>
        <div className="eyebrow">事件详情</div>
        <div className="inspector-title">{title}</div>
      </div>
      <button className="icon-button" onClick={onClose} aria-label="关闭事件详情">
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
      </button>
    </div>
    <div className="agent-scope" role="tablist" aria-label="事件详情分类">
      <button ref={firstTabRef} className={`scope-chip ${tab === 'detail' ? 'scope-chip-active' : ''}`} role="tab" aria-selected={tab === 'detail'} onClick={() => setTab('detail')}>详情</button>
      <button className={`scope-chip ${tab === 'evidence' ? 'scope-chip-active' : ''}`} role="tab" aria-selected={tab === 'evidence'} onClick={() => setTab('evidence')}>证据 · {node.evidence.length}</button>
      <button className={`scope-chip ${tab === 'raw' ? 'scope-chip-active' : ''}`} role="tab" aria-selected={tab === 'raw'} onClick={() => setTab('raw')}>原始数据</button>
    </div>
    {tab === 'detail' && <>
      {node.type === 'tool' ? <StructuredToolDetail node={node}/> : <section className="inspector-section">
        <h3 className="section-label">摘要</h3>
        <div className="evidence-empty-detail">{detailSummary || '当前事件没有额外的结构化详情；可继续查看证据或来源原始记录。'}</div>
      </section>}
    </>}
    {tab === 'evidence' && <section className="inspector-section">
      <h3 className="section-label">证据</h3>
      {node.evidence.length ? node.evidence.map(item => <div key={item.id} className="evidence-card">
        <div className="evidence-meta"><b>{evidenceCaptureLabel[item.captureMethod]}</b><span>{evidenceDerivationLabel[item.derivation] ?? item.derivation}</span><span>可信度：{evidenceConfidenceLabel[item.confidence] ?? item.confidence}</span></div>
        <div className="evidence-path">{item.sourceLocator?.path ?? item.sourceRecordId ?? item.id}</div>
        {item.missingReason && <div className="evidence-missing">证据信息不完整</div>}
      </div>) : <div className="muted-empty">无证据</div>}
    </section>}
    {tab === 'raw' && <section className="inspector-section"><h3 className="section-label">来源原始记录</h3><pre className="raw-json">{JSON.stringify(node.payload, null, 2)}</pre></section>}
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
      <button onClick={() => setView(value => value === 'rendered' ? 'source' : 'rendered')}>{view === 'rendered' ? '查看源码' : '返回渲染'}</button>
    </div>
  </div>
}

function MessageBubble({ node, inspect }: { node: ReviewMessageNodeDto; inspect(node: ReviewNodeDto): void }) {
  if (node.role === 'reasoning') {
    return <details className="thinking-block">
      <summary>
        <span className="thinking-label">可观察过程片段</span>
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
    <div className={`chat-avatar ${user ? 'chat-avatar-user' : 'chat-avatar-agent'}`}>{user ? '你' : '智'}</div>
    <div className={`chat-bubble ${user ? 'chat-bubble-user' : 'chat-bubble-agent'}`}>
      <div className="chat-meta"><span>{user ? '你' : '智能体'}</span><EvidenceBadges evidence={node.evidence}/><time>{formatClock(node.at)}</time></div>
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
    <span className={`execution-tool-icon tool-kind-${info.kind}`}><ToolKindIcon kind={info.kind}/></span>
    <span className="execution-main">
      <span className="execution-name"><b>{node.name}</b><span className="tool-kind-label">{info.label}</span><span className="tool-status-label">{node.status === 'error' ? '失败' : node.status === 'success' ? '完成' : node.status === 'running' ? '执行中' : '未知'}</span><EvidenceBadges evidence={node.evidence} compact/></span>
      {info.primary && <span className="execution-preview execution-primary">{info.primary}</span>}
      {info.secondary && <span className={`execution-preview ${node.status === 'error' ? 'execution-preview-error' : ''}`}>{info.secondary}</span>}
    </span>
    <span className="execution-duration">{node.durationMs !== undefined && node.durationMs > 0 ? duration(node.durationMs) : formatClock(node.at)}</span>
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
      <span className="execution-group-icon" aria-hidden="true"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v4a3 3 0 0 0 3 3h6"/><path d="m9 7 3 3-3 3"/></svg></span>
      <span className="execution-group-copy"><b>工具执行</b><small>{items.length} 次调用</small></span>
      <span className="execution-kind-counts">{typeCounts.map(([kind, count]) => <span key={kind}>{toolKindLabel(kind)} {count}</span>)}</span>
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

function Interaction({
  interaction,
  inspect,
  highLatency,
  defaultExpanded,
  expansionStore,
  forceExpanded,
  forceRevision,
  showRawRecords,
}: {
  interaction: ReviewInteractionDto
  inspect(node: ReviewNodeDto): void
  highLatency: boolean
  defaultExpanded: boolean
  expansionStore: Map<string, boolean>
  forceExpanded: boolean
  forceRevision: number
  showRawRecords: boolean
}) {
  const [expanded, setExpanded] = useState(() => expansionStore.get(interaction.id) ?? defaultExpanded)
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

  useEffect(() => {
    const stored = expansionStore.get(interaction.id)
    if (stored !== undefined) {
      setExpanded(stored)
      return
    }
    if (defaultExpanded) {
      setExpanded(true)
      expansionStore.set(interaction.id, true)
    }
  }, [defaultExpanded, expansionStore, interaction.id])

  useEffect(() => {
    if (forceRevision === 0) return
    setExpanded(forceExpanded)
    expansionStore.set(interaction.id, forceExpanded)
  }, [expansionStore, forceExpanded, forceRevision, interaction.id])

  const onToggle = (open: boolean) => {
    setExpanded(open)
    expansionStore.set(interaction.id, open)
  }

  return <details className={`interaction-block ${stats.errorCount ? 'interaction-has-error' : ''}`} open={expanded} onToggle={event => onToggle(event.currentTarget.open)}>
    <summary className="interaction-summary">
      <span className="interaction-chevron">›</span>
      <span className="interaction-title">{interaction.trigger === 'background' ? '后台活动' : `第 ${interaction.ordinal} 轮`}</span>
      {stats.preview && <span className="interaction-preview">{stats.preview}</span>}
      <span className="interaction-summary-meta">
        {stats.toolCount > 0 && <span>{stats.toolCount} 工具</span>}
        {stats.errorCount > 0 && <span className="is-error">{stats.errorCount} 错误</span>}
        {highLatency && <span className="is-latency">耗时较高</span>}
        {stats.durationMs > 0 && <span>{duration(stats.durationMs)}</span>}
      </span>
    </summary>
    <div className="interaction-flow">{groups.map((entry, index) => {
      if (entry.type === 'tool-group') return <ToolRunGroup key={`tools-${index}`} items={entry.items} inspect={inspect}/>
      if (entry.type === 'raw-event-group') return showRawRecords ? <RawEventGroup key={`raw-${index}`} items={entry.items} inspect={inspect}/> : null
      if (entry.type === 'message') return <MessageBubble key={entry.id} node={entry} inspect={inspect}/>
      return <EventRow key={entry.id} event={entry as ReviewEventNodeDto} inspect={inspect}/>
    })}</div>
  </details>
}

function Metric({ value, label, tone = '' }: { value: string | number; label: string; tone?: 'danger' | '' }) {
  return <div className="review-metric" data-tone={tone}><b>{value}</b><span>{label}</span></div>
}

type RoundFilter = ReviewDetailFilter

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
  const [roundFilterLoading, setRoundFilterLoading] = useState(false)
  const [expandAllRounds, setExpandAllRounds] = useState(false)
  const [roundExpansionRevision, setRoundExpansionRevision] = useState(0)
  const [showRawRecords, setShowRawRecords] = useState(false)
  const sessionLoadSentinelRef = useRef<HTMLButtonElement>(null)
  const detailLoadSentinelRef = useRef<HTMLDivElement>(null)
  const readerPaneRef = useRef<HTMLElement>(null)
  const followingTailRef = useRef(false)
  const roundExpansionRef = useRef(new Map<string, boolean>())
  const review = snapshot.review
  const agents = snapshot.facets?.agents ?? []
  const projects = snapshot.facets?.projects ?? []
  const detail = review.detail
  const sessionGroups = useMemo(() => {
    const groups = new Map<'今天' | '昨天' | '更早', ReviewSessionSummaryDto[]>()
    const now = new Date()
    for (const item of review.response?.items ?? []) {
      const label = sessionDayLabel(item.endedAt, now)
      const items = groups.get(label) ?? []
      items.push(item)
      groups.set(label, items)
    }
    return [...groups.entries()].map(([label, items]) => ({ label, items }))
  }, [review.response?.items])

  useEffect(() => { if (sessionId && sessionId !== review.selectedId) void model.selectReviewSession(sessionId) }, [sessionId, review.selectedId, model])
  useEffect(() => {
    roundExpansionRef.current.clear()
    setRoundFilter('all')
    setRoundFilterLoading(false)
    setExpandAllRounds(false)
    setRoundExpansionRevision(0)
    setShowRawRecords(false)
    setInspect(null)
    followingTailRef.current = false
  }, [detail?.id])
  useEffect(() => {
    if (detail?.page.filter) setRoundFilter(detail.page.filter)
  }, [detail?.page.filter])

  useEffect(() => {
    const sentinel = sessionLoadSentinelRef.current
    if (!sentinel || !review.response?.meta.hasMore || review.loading || review.loadingMore || review.error) return
    const root = sentinel.closest('.session-scroll')
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void model.loadMoreReview()
    }, { root, rootMargin: '160px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [review.response?.items.length, review.response?.meta.hasMore, review.loading, review.loadingMore, review.error, model])

  useEffect(() => {
    const sentinel = detailLoadSentinelRef.current
    if (!sentinel || !detail?.page.hasMore || detail.page.direction !== 'forward' || review.detailLoadingMore || review.error) return
    const root = sentinel.closest('.review-reader-pane')
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void model.loadMoreReviewDetail()
    }, { root, rootMargin: '800px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [detail?.id, detail?.page.hasMore, detail?.page.nextCursor, detail?.page.direction, review.detailLoadingMore, review.error, model])

  const lastInteractionKey = detail?.interactions.at(-1)
    ? `${detail.interactions.at(-1)!.id}:${detail.interactions.at(-1)!.endedAt}:${detail.interactions.at(-1)!.nodes.length}`
    : ''
  useEffect(() => {
    if (!review.detailHasNewData || !detail || detail.page.filter !== 'all') return
    const includesTail = detail.page.direction === 'backward' || !detail.page.hasMore
    if (!includesTail || !followingTailRef.current) return
    const frame = window.requestAnimationFrame(() => {
      const pane = readerPaneRef.current
      if (!pane) return
      pane.scrollTop = pane.scrollHeight
      model.acknowledgeReviewNewData()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [review.detailHasNewData, lastInteractionKey, detail?.page.direction, detail?.page.hasMore, detail?.page.filter, model])

  const select = (id: string) => { void model.selectReviewSession(id); navigate(`/review/${encodeURIComponent(id)}`) }
  const scrollTop = () => window.requestAnimationFrame(() => { if (readerPaneRef.current) readerPaneRef.current.scrollTop = 0 })
  const scrollBottom = () => window.requestAnimationFrame(() => {
    const pane = readerPaneRef.current
    if (!pane) return
    pane.scrollTop = pane.scrollHeight
    followingTailRef.current = true
    model.acknowledgeReviewNewData()
  })

  const selectRoundFilter = async (filter: RoundFilter) => {
    if (!detail || roundFilterLoading) return
    const selectedId = detail.id
    setRoundFilterLoading(true)
    try {
      if (filter === 'all') {
        await model.showReviewFromStart()
        if (model.getSnapshot().review.selectedId === selectedId) {
          setRoundFilter('all')
          scrollTop()
        }
      } else {
        await model.selectReviewDetailFilter(filter)
        if (model.getSnapshot().review.selectedId === selectedId) {
          setRoundFilter(filter)
          scrollTop()
        }
      }
    } finally {
      if (model.getSnapshot().review.selectedId === selectedId) setRoundFilterLoading(false)
    }
  }

  const jumpToLatest = async () => {
    if (!detail || roundFilterLoading) return
    const selectedId = detail.id
    setRoundFilterLoading(true)
    try {
      await model.jumpToLatestReviewDetail()
      if (model.getSnapshot().review.selectedId === selectedId) {
        setRoundFilter('all')
        scrollBottom()
      }
    } finally {
      if (model.getSnapshot().review.selectedId === selectedId) setRoundFilterLoading(false)
    }
  }

  const loadOlder = async () => {
    const pane = readerPaneRef.current
    if (!pane || review.detailLoadingMore) return
    const beforeHeight = pane.scrollHeight
    const beforeTop = pane.scrollTop
    await model.loadMoreReviewDetail()
    window.requestAnimationFrame(() => {
      const current = readerPaneRef.current
      if (!current) return
      current.scrollTop = beforeTop + (current.scrollHeight - beforeHeight)
    })
  }

  const threshold = useMemo(() => {
    if (!detail) return null
    if (detail.page.latencyThresholdMs !== undefined) return detail.page.latencyThresholdMs
    if (detail.page.filter === 'all' && detail.page.direction === 'forward' && !detail.page.hasMore) {
      return highLatencyThreshold(detail.interactions)
    }
    return null
  }, [detail])
  const annotatedInteractions = useMemo(() => (detail?.interactions ?? []).map(interaction => {
    const stats = interactionStats(interaction)
    return {
      interaction,
      stats,
      highLatency: detail?.page.filter === 'latency' || (threshold !== null && stats.durationMs >= threshold),
    }
  }), [detail, threshold])
  const pageIncomplete = detail?.page.hasMore ?? false
  const isBackward = detail?.page.direction === 'backward'
  const isFiltered = roundFilter !== 'all'

  const onReaderScroll = () => {
    const pane = readerPaneRef.current
    if (!pane) return
    followingTailRef.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 180
    if (followingTailRef.current && review.detailHasNewData && detail?.page.filter === 'all') {
      const includesTail = detail.page.direction === 'backward' || !detail.page.hasMore
      if (includesTail) model.acknowledgeReviewNewData()
    }
  }

  const emptyLabel = roundFilter === 'errors'
    ? '完整会话没有错误轮次。'
    : roundFilter === 'latency'
      ? '完整会话没有相对耗时较高的轮次。'
      : '当前筛选条件没有匹配的轮次。'

  const toggleRoundExpansion = () => {
    setExpandAllRounds(value => !value)
    setRoundExpansionRevision(value => value + 1)
  }

  return <main className="review-page">
    <div className="workspace-toolbar">
      <AgentScope agents={agents} value={review.filters.sourceId} onChange={sourceId => model.setReviewFilters({ sourceId })}/>
      <span className="toolbar-divider" />
      <select className="filter" value={review.filters.projectId} onChange={e => model.setReviewFilters({ projectId: e.target.value })}><option value="">全部项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name ?? p.repositoryIdentity ?? p.id}</option>)}</select>
      <select className="filter" value={review.filters.range} onChange={e => model.setReviewFilters({ range: e.target.value as typeof review.filters.range })}><option value="today">今天</option><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="all">全部时间</option></select>
      <select className="filter" value={review.filters.status} onChange={e => model.setReviewFilters({ status: e.target.value as typeof review.filters.status })}><option value="all">全部状态</option><option value="clean">无错误</option><option value="with-errors">有错误</option></select>
      <input className="filter search-filter" placeholder="搜索会话…" value={review.filters.search} onChange={e => model.setReviewFilters({ search: e.target.value })}/>
      <button className="icon-button" onClick={() => void model.refreshReview()} title="刷新" aria-label="刷新"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M13 3v4H9"/><path d="M12.2 6A5 5 0 1 0 13 9"/></svg></button>
    </div>

    <div className="review-layout">
      <aside className="session-panel">
        <div className="session-panel-head"><div><b>会话</b><span>按时间倒序</span></div><span className="count-badge">{review.response?.items.length ?? 0}{review.response?.meta.hasMore ? '+' : ''}</span></div>
        <div className="session-scroll">
          {review.loading && !review.response && <div className="empty-state">加载会话…</div>}
          {sessionGroups.map(group => <section className="session-group-block" key={group.label}>
            <div className="session-group">{group.label}</div>
            {group.items.map(item => <button key={item.id} className={`session-item ${review.selectedId === item.id ? 'session-item-active' : ''}`} onClick={() => select(item.id)}>
              <div className="session-item-meta"><span className={`source-dot ${sourceDot(item.sourceIds[0] ?? '')}`}/><span>{agentLabel(item.sourceIds[0] ?? '', item.productId)}</span><time title={formatTime(item.endedAt)}>{sessionRelativeTime(item.endedAt)}</time></div>
              <div className="session-item-title">{sessionTitle([item.title, item.preview], item.projectName ? `${item.projectName} 会话` : `${agentLabel(item.sourceIds[0] ?? '', item.productId)} 会话`, 74)}</div>
              <div className="session-item-foot"><span>{item.projectName ?? item.workspacePath?.split(/[\\/]/).pop() ?? '无项目'}</span><span>{item.toolCount} 调用{item.errorCount > 0 ? ` · ${item.errorCount} 错误` : ''}</span></div>
            </button>)}
          </section>)}
          {review.response?.meta.hasMore && <button ref={sessionLoadSentinelRef} className="session-load-more" disabled={review.loadingMore} onClick={() => void model.loadMoreReview()}>{review.loadingMore ? '正在加载更多会话…' : review.error ? '加载失败 · 点击重试' : '继续向下滚动，自动加载更多会话'}</button>}
          {review.response && !review.response.meta.hasMore && review.response.items.length > 0 && <div className="session-load-more" aria-live="polite">已加载全部会话</div>}
          {!review.loading && !review.response?.items.length && <div className="empty-state">当前筛选范围没有会话</div>}
        </div>
      </aside>

      <section ref={readerPaneRef} className="review-reader-pane" onScroll={onReaderScroll}>
        {review.error && <div className="page-error">{review.error}</div>}
        {!detail ? <div className="empty-state fill">{review.selectedId && review.detailLoading ? '加载会话详情…' : '选择一个会话开始复盘'}</div> : <div className="review-reader">
          <header className="review-session-head">
            <div className="review-session-copy">
              <div className="review-session-meta"><span className={`source-dot ${sourceDot(detail.sourceIds[0] ?? '')}`}/><b>{detail.sourceIds.map(id => agentLabel(id)).join(' / ')}</b><span>{detail.projectName ?? '无项目'}</span>{detail.errorCount > 0 && <span className="session-status-error">有错误</span>}</div>
              <h1 className="review-session-title" title={sessionTitle([detail.title, detail.preview], detail.projectName ? `${detail.projectName} 会话` : `${agentLabel(detail.sourceIds[0] ?? '')} 会话`)}>{sessionTitle([detail.title, detail.preview], detail.projectName ? `${detail.projectName} 会话` : `${agentLabel(detail.sourceIds[0] ?? '')} 会话`)}</h1>
              <div className="review-session-submeta">
                <span>{formatRange(detail.startedAt, detail.endedAt)}</span>
                {detail.workspacePath && <code title={detail.workspacePath}>{detail.workspacePath}</code>}
              </div>
              <div className="review-audit-controls">
                <button className="review-audit-toggle" aria-pressed={showRawRecords} onClick={() => setShowRawRecords(value => !value)}>{showRawRecords ? '隐藏原始记录' : '显示原始记录'}</button>
                {showRawRecords && <span>原始记录视图：补充来源原始事件与载荷；Evidence（证据）始终保持可见。</span>}
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
            <summary>Pi 会话树 · {review.relationships.items.length} 条关系</summary>
            <div>{review.relationships.items.map(item => <div key={item.id}>{item.fromNativeSessionId ?? item.fromSessionId} <span>→</span> {item.toNativeSessionId ?? item.toSessionId}</div>)}</div>
          </details> : null}

          <div className="round-nav" aria-label="轮次快速导航">
            <button className={roundFilter === 'all' && !isBackward ? 'active' : ''} disabled={roundFilterLoading} onClick={() => void selectRoundFilter('all')}>全部 {roundFilter === 'all' && !isBackward && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</button>
            <button className={roundFilter === 'errors' ? 'active' : ''} disabled={roundFilterLoading} onClick={() => void selectRoundFilter('errors')}>有错误 {roundFilter === 'errors' && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</button>
            <button className={roundFilter === 'latency' ? 'active' : ''} disabled={roundFilterLoading} onClick={() => void selectRoundFilter('latency')}>耗时较高 {roundFilter === 'latency' && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</button>
            <button className={isBackward && roundFilter === 'all' ? 'active' : ''} disabled={roundFilterLoading} onClick={() => void jumpToLatest()}>跳到最新 ↓</button>
            <button className="round-nav-expand" disabled={roundFilterLoading} onClick={toggleRoundExpansion}>{expandAllRounds ? '收起当前页' : '展开当前页'}</button>
            {isBackward && roundFilter === 'all' && pageIncomplete && <button disabled={roundFilterLoading} onClick={() => void model.showReviewFromStart().then(scrollTop)}>从头查看 ↑</button>}
            {roundFilterLoading && <span className="round-nav-status">正在查询完整会话…</span>}
            {review.detailHasNewData && <button className="round-nav-live" onClick={() => void jumpToLatest()}>有新记录 ↓</button>}
            <small>“耗时较高”由服务器基于完整会话的轮次耗时分布计算。</small>
          </div>

          <div className="review-flow">
            {isBackward && roundFilter === 'all' && pageIncomplete && <div className="detail-load-sentinel detail-load-sentinel-top" aria-live="polite">
              {review.detailLoadingMore ? '正在加载更早轮次…' : review.error ? <button onClick={() => void loadOlder()}>加载失败 · 重试</button> : <button onClick={() => void loadOlder()}>加载更早轮次</button>}
            </div>}
            {annotatedInteractions.map((item, index) => <VirtualRoundMount
              key={item.interaction.id}
              eager={index < 6 || item.interaction.id === annotatedInteractions.at(-1)?.interaction.id}
              estimate={item.stats.toolCount > 12 ? 420 : item.stats.toolCount > 4 ? 300 : 220}
            >
              <Interaction
                interaction={item.interaction}
                highLatency={item.highLatency}
                defaultExpanded={expandAllRounds || item.stats.errorCount > 0 || isFiltered || item.interaction.id === annotatedInteractions.at(-1)?.interaction.id}
                expansionStore={roundExpansionRef.current}
                forceExpanded={expandAllRounds}
                forceRevision={roundExpansionRevision}
                showRawRecords={showRawRecords}
                inspect={setInspect}
              />
            </VirtualRoundMount>)}
            {!annotatedInteractions.length && <div className="round-filter-empty">{emptyLabel}</div>}
            {!isBackward && roundFilter !== 'latest' && <div ref={detailLoadSentinelRef} className="detail-load-sentinel" aria-live="polite">
              {review.detailLoadingMore
                ? `正在加载${isFiltered ? '后续匹配' : '后续'}轮次…`
                : detail.page.hasMore
                  ? review.error
                    ? <button onClick={() => void model.loadMoreReviewDetail()}>加载失败 · 重试</button>
                    : `继续向下滚动，${isFiltered ? '后续匹配' : '后续'}轮次会自动加载`
                  : isFiltered
                    ? `已加载全部 ${detail.interactions.length} 个匹配轮次`
                    : `已完整加载 ${detail.interactions.length} 轮`}
            </div>}
          </div>
        </div>}
      </section>
    </div>
    {inspect && <Inspector node={inspect} onClose={() => setInspect(null)}/>} 
  </main>
}