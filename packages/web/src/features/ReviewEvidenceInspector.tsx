import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { JsonValue, ReviewEventNodeDto, ReviewMessageNodeDto, ReviewNodeDto, SourceRecordResponseDto, ReviewToolNodeDto, TimelineEvidenceDto } from '@agent-lens/protocol'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { MarkdownContent } from '../components/MarkdownContent'
import { LocalResourceReference } from '../components/LocalResourceReference'
import { ToolKindIcon, toolVisualKind, type ToolVisualKind } from '../components/ToolKindIcon'
import { Button, Drawer } from '../components/ui'
import { reviewArtifactSummary, reviewEventLabel } from './review-event-presentation'
import { reviewToolCommand } from './review-tool-command'
import { agentLensI18n } from '../i18n/runtime'
import { currentLocale, duration } from './review-session-format'

function payloadRecord(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}
}

function jsonString(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}

export function brief(value: unknown, max = 120): string {
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

function arrayCount(value: JsonValue | undefined): number {
  return Array.isArray(value) ? value.length : 0
}

function runtimeStartupSummary(value: JsonValue): string {
  const payload = payloadRecord(value)
  const resources = payload.resources
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    return agentLensI18n.t('review:local.event.runtimeStartupNotCaptured')
  }
  const record = payloadRecord(resources)
  const counts = {
    contexts: arrayCount(record.contexts),
    skills: arrayCount(record.skills),
    prompts: arrayCount(record.prompts),
    extensions: arrayCount(record.extensions),
    themes: arrayCount(record.themes),
  }
  const hasKnownResources = Object.values(counts).some(count => count > 0)
  const incomplete = arrayCount(record.diagnostics) > 0
  const parts = [incomplete && !hasKnownResources
    ? agentLensI18n.t('review:local.event.runtimeResourcesIncomplete')
    : agentLensI18n.t('review:local.event.runtimeResourceCounts', counts)]
  if (incomplete && hasKnownResources) parts.push(agentLensI18n.t('review:local.event.runtimeResourcesPartial'))
  const packageStatus = typeof payload.packageUpdateCheck === 'string' ? payload.packageUpdateCheck : ''
  if (packageStatus === 'complete') {
    parts.push(agentLensI18n.t('review:local.event.runtimePackageUpdatesCount', {
      count: arrayCount(payload.packageUpdates),
    }))
  } else if (packageStatus === 'unavailable') {
    parts.push(agentLensI18n.t('review:local.event.runtimePackageUpdatesUnavailable'))
  } else if (packageStatus === 'failed') {
    parts.push(agentLensI18n.t('review:local.event.runtimePackageUpdatesFailed'))
  }
  return parts.join(' · ')
}

const evidenceCaptureKey: Record<TimelineEvidenceDto['captureMethod'], string> = {
  'runtime-hook': 'review:local.evidence.capture.runtimeHook',
  'native-log': 'review:local.evidence.capture.nativeLog',
  'native-db': 'review:local.evidence.capture.nativeDb',
  'static-scan': 'review:local.evidence.capture.staticScan',
  'external-import': 'review:local.evidence.capture.externalImport',
}

const evidenceDerivationKey: Record<string, string> = {
  observed: 'review:local.evidence.derivation.observed',
  reported: 'review:local.evidence.derivation.reported',
  derived: 'review:local.evidence.derivation.derived',
  estimated: 'review:local.evidence.derivation.estimated',
  inferred: 'review:local.evidence.derivation.inferred',
}

const evidenceConfidenceKey: Record<string, string> = {
  exact: 'review:local.evidence.confidence.exact',
  high: 'review:local.evidence.confidence.high',
  medium: 'review:local.evidence.confidence.medium',
  low: 'review:local.evidence.confidence.low',
  unknown: 'review:local.evidence.confidence.unknown',
}

function evidenceLabel(map: Record<string, string>, value: string): string {
  const key = map[value]
  return key ? agentLensI18n.t(key) : value
}

export function EvidenceBadges({ evidence, compact = false }: { evidence: TimelineEvidenceDto[]; compact?: boolean }) {
  const { i18n } = useTranslation('review')
  const localeRevision = i18n.resolvedLanguage ?? i18n.language
  const displayEvidence = useMemo(() => evidence.filter(item => item.captureMethod !== 'native-log'
    || item.derivation === 'inferred' || item.derivation === 'estimated'), [evidence])
  const visible = useMemo(() => {
    const seen = new Set<string>()
    const items: Array<{ key: string; label: string; confidence: string; title: string }> = []
    for (const item of displayEvidence) {
      const key = `${item.captureMethod}:${item.derivation}:${item.confidence}`
      if (seen.has(key)) continue
      seen.add(key)
      const derivation = item.derivation === 'inferred' || item.derivation === 'estimated' ? evidenceLabel(evidenceDerivationKey, item.derivation) : ''
      const label = derivation || evidenceLabel(evidenceCaptureKey, item.captureMethod)
      items.push({
        key,
        label,
        confidence: item.confidence,
        title: [
          evidenceLabel(evidenceCaptureKey, item.captureMethod),
          agentLensI18n.t('review:local.evidence.source', { value: evidenceLabel(evidenceDerivationKey, item.derivation) }),
          agentLensI18n.t('review:local.evidence.confidenceLabel', { value: evidenceLabel(evidenceConfidenceKey, item.confidence) }),
          item.missingReason ? agentLensI18n.t('review:local.evidence.incomplete') : '',
        ].filter(Boolean).join(' · '),
      })
    }
    return items.slice(0, compact ? 1 : 2)
  }, [displayEvidence, compact, localeRevision])

  if (!visible.length) return null
  return <span className="evidence-inline-list">
    {visible.map(item => <span key={item.key} className="evidence-inline" data-confidence={item.confidence} title={item.title}>{item.label}</span>)}
    {displayEvidence.length > visible.length && !compact && <span className="evidence-inline-more">+{displayEvidence.length - visible.length}</span>}
  </span>
}

export function sourceEventSummary(node: ReviewEventNodeDto): string {
  const payload = payloadRecord(node.payload)
  const action = stringValue(payload, 'action', 'event', 'type', 'status')
  if (node.kind === 'runtime.startup') return runtimeStartupSummary(node.payload)
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
    return [type, agentId ? agentLensI18n.t('review:local.event.subagent', { id: agentId }) : ''].filter(Boolean).join(' · ') || brief(payload, 140)
  }
  if (node.kind === 'context.compaction') {
    const trigger = stringValue(payload, 'trigger', 'compactTrigger', 'compact_trigger', 'reason', 'compactReason', 'compact_reason')
    const before = numberValue(payload, 'tokensBefore', 'tokens_before')
    return [trigger ? agentLensI18n.t('review:local.event.trigger', { value: trigger }) : '', before !== undefined ? agentLensI18n.t('review:local.event.beforeCompaction', { count: before.toLocaleString(currentLocale()) }) : ''].filter(Boolean).join(' · ') || brief(payload, 100)
  }
  if (node.kind === 'context.summary') {
    return brief(payload.summary ?? payload.text ?? payload.content ?? payload, 120)
  }
  if (node.kind === 'context.injected') {
    const role = stringValue(payload, 'role')
    const text = stringValue(payload, 'text')
    if (text) return [role, brief(text, 180)].filter(Boolean).join(' · ')
    return role ? agentLensI18n.t('review:local.event.roleMissingBody', { role }) : agentLensI18n.t('review:local.event.missingBody')
  }
  if (node.kind === 'session.lifecycle') {
    if (action === 'turn.context') {
      const model = stringValue(payload, 'model')
      const cwd = stringValue(payload, 'cwd')
      const sandbox = brief(payload.sandbox_policy ?? payload.sandboxPolicy, 80)
      const approval = brief(payload.approval_policy ?? payload.approvalPolicy, 80)
      const reasoning = brief(payload.reasoning_effort ?? payload.reasoningEffort, 80)
      const collaboration = brief(payload.collaboration_mode ?? payload.collaborationMode, 80)
      return [model, cwd, sandbox ? agentLensI18n.t('review:local.event.sandbox', { value: sandbox }) : '', approval ? agentLensI18n.t('review:local.event.approval', { value: approval }) : '', reasoning ? agentLensI18n.t('review:local.event.reasoning', { value: reasoning }) : '', collaboration ? agentLensI18n.t('review:local.event.collaboration', { value: collaboration }) : ''].filter(Boolean).join(' · ') || brief(payload, 140)
    }
    if (action === 'session.discovered') {
      const parent = stringValue(payload, 'forked_from_id', 'parent_thread_id')
      const agent = stringValue(payload, 'agent_nickname', 'agent_path')
      const role = stringValue(payload, 'agent_role')
      const source = stringValue(payload, 'thread_source', 'source')
      return [parent ? agentLensI18n.t('review:local.event.parentThread', { value: parent }) : '', agent ? `Agent ${agent}` : '', role, source].filter(Boolean).join(' · ') || brief(payload, 140)
    }
    const startSource = stringValue(payload, 'startSource', 'start_source', 'source')
    const reason = stringValue(payload, 'reason', 'lifecycleReason', 'lifecycle_reason', 'stopReason', 'stop_reason')
    const model = stringValue(payload, 'model')
    return [action, startSource ? agentLensI18n.t('review:local.event.sourceValue', { value: startSource }) : '', reason ? agentLensI18n.t('review:local.event.reason', { value: reason }) : '', model].filter(Boolean).join(' · ') || brief(payload, 100)
  }
  if (node.kind === 'usage') {
    const input = numberValue(payload, 'inputTokens', 'input_tokens')
    const output = numberValue(payload, 'outputTokens', 'output_tokens')
    const cacheRead = numberValue(payload, 'cacheReadTokens', 'cached_input_tokens', 'cache_read_tokens')
    const total = numberValue(payload, 'totalTokens', 'total_tokens')
    if (input !== undefined || output !== undefined || cacheRead !== undefined || total !== undefined) {
      return agentLensI18n.t('review:local.event.tokens', {
        value: [
          agentLensI18n.t('review:local.event.usageInput', { count: input ?? 0 }),
          agentLensI18n.t('review:local.event.usageOutput', { count: output ?? 0 }),
          cacheRead ? agentLensI18n.t('review:local.event.usageCacheRead', { count: cacheRead }) : '',
          total !== undefined ? agentLensI18n.t('review:local.event.usageTotal', { count: total }) : '',
        ].filter(Boolean).join(' · '),
      })
    }
  }
  if (node.kind === 'artifact.action') {
    const summary = reviewArtifactSummary(node.payload)
    if (summary) return summary
    const path = stringValue(payload, 'path', 'filePath', 'file_path')
    return [action, path].filter(Boolean).join(' · ') || brief(payload, 100)
  }
  return action || brief(payload, 100)
}

export function toolKindLabel(kind: ToolVisualKind): string {
  if (kind === 'shell') return agentLensI18n.t('review:local.tool.command')
  if (kind === 'read') return agentLensI18n.t('review:local.tool.read')
  if (kind === 'edit') return agentLensI18n.t('review:local.tool.edit')
  if (kind === 'search') return agentLensI18n.t('review:local.tool.search')
  if (kind === 'test') return agentLensI18n.t('task:tool.kind.test')
  if (kind === 'mcp') return agentLensI18n.t('review:local.tool.mcp')
  if (kind === 'web') return agentLensI18n.t('review:local.tool.web')
  return agentLensI18n.t('review:local.tool.generic')
}

function toolInputRecord(node: ReviewToolNodeDto): Record<string, JsonValue> {
  return payloadRecord(node.input)
}

export function toolPresentation(node: ReviewToolNodeDto): { kind: ToolVisualKind; label: string; primary: string; secondary: string } {
  const input = toolInputRecord(node)
  const kind = toolVisualKind(node.name, { sourceType: node.toolSourceType, mcpServerId: node.mcpServerId })
  const output = brief(node.output, 110)
  if (kind === 'shell') {
    const command = reviewToolCommand(node.input) || brief(node.input, 140)
    return { kind, label: toolKindLabel(kind), primary: command, secondary: output }
  }
  if (kind === 'read') {
    const path = stringValue(input, 'path', 'file_path', 'filePath', 'filename') || brief(node.input, 120)
    return { kind, label: toolKindLabel(kind), primary: path, secondary: output }
  }
  if (kind === 'edit') {
    const path = stringValue(input, 'path', 'file_path', 'filePath', 'filename', 'new_path', 'old_path') || brief(node.input, 120)
    const patch = stringValue(input, 'patch', 'diff', 'content')
    return { kind, label: toolKindLabel(kind), primary: path, secondary: patch ? brief(patch, 110) : output }
  }
  if (kind === 'search') {
    const query = stringValue(input, 'query', 'pattern', 'search', 'glob') || brief(node.input, 120)
    const path = stringValue(input, 'path', 'cwd', 'directory')
    return { kind, label: toolKindLabel(kind), primary: query, secondary: path || output }
  }
  if (kind === 'mcp') {
    const target = stringValue(input, 'tool', 'server', 'mcp_server', 'name', 'method') || brief(node.input, 120)
    return { kind, label: toolKindLabel(kind), primary: target, secondary: output }
  }
  if (kind === 'web') {
    const target = stringValue(input, 'url', 'query', 'href', 'path') || brief(node.input, 120)
    return { kind, label: toolKindLabel(kind), primary: target, secondary: output }
  }
  return { kind, label: toolKindLabel(kind), primary: brief(node.input, 130), secondary: output }
}

function toolLocalResource(node: ReviewToolNodeDto): { value: string; kind: 'file' | 'directory'; placement: 'primary' | 'secondary' } | undefined {
  const input = toolInputRecord(node)
  const kind = toolVisualKind(node.name, { sourceType: node.toolSourceType, mcpServerId: node.mcpServerId })
  if (kind === 'read' || kind === 'edit') {
    const path = stringValue(input, 'path', 'file_path', 'filePath', 'filename', 'new_path', 'old_path')
    return path ? { value: path, kind: 'file', placement: 'primary' } : undefined
  }
  if (kind === 'search') {
    const path = stringValue(input, 'path', 'cwd', 'directory')
    return path ? { value: path, kind: 'directory', placement: 'secondary' } : undefined
  }
  return undefined
}

/** Prefer original Markdown body when native JSON carries a text field. */
function originalMarkdownBody(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  for (const record of [value, payloadRecord(value.payload)]) {
    for (const key of ['text', 'content', 'message', 'body']) {
      if (typeof record[key] === 'string') return record[key]
    }
  }
  return undefined
}

/** Full source content; only timeline row summaries may use brief(). */
function OriginalEvidenceValue({ value }: { value: JsonValue | undefined }) {
  const { t } = useTranslation('review')
  const [showSource, setShowSource] = useState(false)
  if (value === undefined) return <div className="muted-empty compact">{t('local.tool.noData')}</div>
  const markdownBody = originalMarkdownBody(value)
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return <div className="inspector-original-value">
    {markdownBody !== undefined && <div className="inspector-original-actions">
      <Button size="small" aria-pressed={!showSource} onClick={() => setShowSource(false)}>{t('local.markdown.rendered')}</Button>
      <Button size="small" aria-pressed={showSource} onClick={() => setShowSource(true)}>{t('local.markdown.source')}</Button>
    </div>}
    {markdownBody !== undefined && !showSource
      ? <MarkdownContent className="inspector-original-markdown" text={markdownBody}/>
      : <CopyableCodeBlock className="raw-json" copyValue={content} language={typeof value === 'string' ? undefined : 'json'}>{content}</CopyableCodeBlock>}
  </div>
}

export function toolOutputText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function StructuredToolDetail({ node }: { node: ReviewToolNodeDto }) {
  const { t } = useTranslation('review')
  const kind = toolVisualKind(node.name, { sourceType: node.toolSourceType, mcpServerId: node.mcpServerId })
  const resource = toolLocalResource(node)
  const status = node.status === 'error' ? t('local.tool.statusError')
    : node.status === 'success' ? t('local.tool.statusSuccess')
    : node.status === 'running' ? t('local.tool.statusRunning')
    : t('local.tool.statusUnknown')
  return <section className="tool-detail">
    <div className="tool-detail-summary">
      <span className={`tool-detail-icon tool-kind-${kind}`}><ToolKindIcon kind={kind}/></span>
      <div><b>{node.name}</b><span>{toolKindLabel(kind)} · {status}{node.durationMs !== undefined && node.durationMs > 0 ? ` · ${duration(node.durationMs)}` : ''}</span></div>
    </div>
    {resource && <div className="tool-detail-section"><h4>{t('local.tool.path')}</h4><LocalResourceReference value={resource.value} kind={resource.kind} className="tool-detail-local-resource"/></div>}
    {node.input !== undefined && <div className="tool-detail-section"><h4>{t('local.tool.structuredInput')}</h4><OriginalEvidenceValue value={node.input}/></div>}
    {node.output !== undefined && <div className={`tool-detail-section ${node.status === 'error' ? 'is-error' : ''}`}><h4>{node.status === 'error' ? t('local.tool.errorOutput') : t('local.tool.output')}</h4><OriginalEvidenceValue value={node.output}/></div>}
  </section>
}

function roleLabel(role: ReviewMessageNodeDto['role']): string {
  if (role === 'user') return agentLensI18n.t('review:local.role.user')
  if (role === 'assistant') return agentLensI18n.t('review:local.role.assistant')
  if (role === 'commentary') return agentLensI18n.t('review:local.role.commentary')
  return agentLensI18n.t('review:local.role.thinking')
}

type InspectorTab = 'detail' | 'evidence' | 'raw'

function RawInspectorContent({
  node,
  records,
  loading,
  error,
}: {
  node: ReviewNodeDto
  records: SourceRecordResponseDto[]
  loading: boolean
  error: string
}) {
  return <section className="inspector-section">
    <h3 className="section-label">{agentLensI18n.t('review:local.event.rawInspector')}</h3>
    <div className="evidence-card">
      <div className="evidence-meta"><b>{agentLensI18n.t('review:local.event.source')}</b><span>{node.sourceId}</span><span>{node.type}</span></div>
      <div className="evidence-path">{agentLensI18n.t('review:local.event.observation')} {node.id}</div>
      {node.nativeEventId && <div className="evidence-path">{agentLensI18n.t('review:local.event.nativeId')}：{node.nativeEventId}</div>}
      {node.nativeParentEventId && <div className="evidence-path">{agentLensI18n.t('review:local.event.nativeParentEventId')}：{node.nativeParentEventId}</div>}
      {node.parentObservationId && <div className="evidence-path">{agentLensI18n.t('review:local.event.parentObservation')}：{node.parentObservationId}</div>}
      {node.occurredAt && <div className="evidence-path">occurredAt：{node.occurredAt}</div>}
      <div className="evidence-path">capturedAt：{node.capturedAt}</div>
    </div>
    {loading && <div className="muted-empty compact">{agentLensI18n.t('review:local.event.rawLoading')}</div>}
    {error && <div className="evidence-missing">{error}</div>}
    {!loading && !error && records.map(record => {
      const evidence = node.evidence.find(item => item.sourceRecordId === record.id)
      return <div key={record.id} className="evidence-card raw-source-record">
        <div className="evidence-meta"><b>{record.nativeType}</b><span>{agentLensI18n.t('review:local.event.parser')} {record.parserVersion}</span>{evidence && <span>{evidence.captureMethod} · {evidence.confidence}</span>}</div>
        <div className="evidence-path">{agentLensI18n.t('review:local.event.sourceRecord')} {record.id}</div>
        {record.nativeId && <div className="evidence-path">{agentLensI18n.t('review:local.event.nativeId')}：{record.nativeId}</div>}
        {record.occurredAt && <div className="evidence-path">occurredAt：{record.occurredAt}</div>}
        <div className="evidence-path">capturedAt：{record.capturedAt}</div>
        {record.locator.path && <div className="evidence-path"><LocalResourceReference
          value={record.locator.path}
          kind={record.locator.kind === 'file' ? 'file' : 'path'}
          presentation="inline"
        /></div>}
        <div className="evidence-path">{agentLensI18n.t('review:local.event.locator')}：{JSON.stringify(record.locator)}</div>
        <OriginalEvidenceValue key={record.id} value={record.payload}/>
      </div>
    })}
    {!loading && !error && records.length === 0 && <>
      <div className="evidence-empty-detail">{agentLensI18n.t('review:local.event.rawMissing')}</div>
      <OriginalEvidenceValue value={node.payload}/>
    </>}
  </section>
}

export function Inspector({ node, onClose, loadSourceRecords }: { node: ReviewNodeDto; onClose(): void; loadSourceRecords(ids: readonly string[]): Promise<SourceRecordResponseDto[]> }) {
  const { t } = useTranslation('review')
  const [tab, setTab] = useState<InspectorTab>('detail')
  const sourceRecordIds = useMemo(() => [...new Set(node.evidence.map(item => item.sourceRecordId).filter((id): id is string => Boolean(id)))], [node.evidence])
  const [rawRecords, setRawRecords] = useState<SourceRecordResponseDto[]>([])
  const [rawLoading, setRawLoading] = useState(false)
  const [rawError, setRawError] = useState('')

  useEffect(() => {
    let active = true
    setRawRecords([])
    setRawError('')
    if (!sourceRecordIds.length) return () => { active = false }
    setRawLoading(true)
    void loadSourceRecords(sourceRecordIds).then(
      records => { if (active) { setRawRecords(records); setRawLoading(false) } },
      reason => { if (active) { setRawError(reason instanceof Error ? reason.message : String(reason)); setRawLoading(false) } },
    )
    return () => { active = false }
  }, [loadSourceRecords, node.id, sourceRecordIds])

  const title = node.type === 'tool' ? node.name : node.type === 'event' ? reviewEventLabel(node) : roleLabel(node.role)
  const resource = node.type === 'tool' ? toolLocalResource(node) : undefined
  return <Drawer
    open
    className="review-inspector-overlay"
    title={title}
    onClose={onClose}
  >
    <div className="agent-scope" role="tablist" aria-orientation="horizontal" aria-label={t('local.event.categoriesAria')}
      onKeyDown={event => {
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        const current = tabs.indexOf(event.target as HTMLButtonElement)
        if (current < 0) return
        const next = event.key === 'ArrowRight' ? (current + 1) % tabs.length
          : event.key === 'ArrowLeft' ? (current + tabs.length - 1) % tabs.length
          : event.key === 'Home' ? 0
          : event.key === 'End' ? tabs.length - 1
          : -1
        if (next < 0) return
        event.preventDefault()
        tabs[next]?.focus({ preventScroll: true })
        setTab((['detail', 'evidence', 'raw'] as const)[next]!)
      }}
    >
      <button className={`scope-chip ${tab === 'detail' ? 'scope-chip-active' : ''}`} role="tab" tabIndex={tab === 'detail' ? 0 : -1} aria-selected={tab === 'detail'} onClick={() => setTab('detail')}>{t('local.event.detail')}</button>
      <button className={`scope-chip ${tab === 'evidence' ? 'scope-chip-active' : ''}`} role="tab" tabIndex={tab === 'evidence' ? 0 : -1} aria-selected={tab === 'evidence'} onClick={() => setTab('evidence')}>{t('local.event.evidence', { count: node.evidence.length })}</button>
      <button className={`scope-chip ${tab === 'raw' ? 'scope-chip-active' : ''}`} role="tab" tabIndex={tab === 'raw' ? 0 : -1} aria-selected={tab === 'raw'} onClick={() => setTab('raw')}>{t('local.event.raw')}</button>
    </div>
    {tab === 'detail' && <section className="inspector-section">
      <h3 className="section-label">{t('local.event.originalContent')}</h3>
      {rawLoading && <div className="muted-empty compact">{t('local.event.rawLoading')}</div>}
      {rawError && <div className="evidence-missing">{rawError}</div>}
      {!rawLoading && rawRecords.length > 0
        ? <>
          {resource && <div className="tool-detail-section"><LocalResourceReference value={resource.value} kind={resource.kind} className="tool-detail-local-resource"/></div>}
          {rawRecords.map(record => <div className="inspector-source-entry" key={record.id}>
            <div className="evidence-meta"><b>{record.nativeType}</b><span>{record.id}</span></div>
            <OriginalEvidenceValue value={record.payload}/>
          </div>)}
        </>
        : !rawLoading && (node.type === 'tool'
          ? <StructuredToolDetail node={node}/>
          : <OriginalEvidenceValue value={node.type === 'message' ? node.text : node.payload}/>)}
    </section>}
    {tab === 'evidence' && <section className="inspector-section">
      <h3 className="section-label">{t('local.event.evidence', { count: node.evidence.length })}</h3>
      {node.evidence.length ? node.evidence.map(item => <div key={item.id} className="evidence-card">
        <div className="evidence-meta"><b>{evidenceLabel(evidenceCaptureKey, item.captureMethod)}</b><span>{evidenceLabel(evidenceDerivationKey, item.derivation)}</span><span>{t('local.evidence.confidenceLabel', { value: evidenceLabel(evidenceConfidenceKey, item.confidence) })}</span></div>
        <div className="evidence-path">{
          item.sourceLocator?.path
            ? <LocalResourceReference
                value={item.sourceLocator.path}
                kind={item.sourceLocator.kind === 'file' ? 'file' : 'path'}
                presentation="inline"
              />
            : item.sourceRecordId ?? item.id
        }</div>
        {item.missingReason && <div className="evidence-missing">{t('local.evidence.incomplete')}</div>}
      </div>) : <div className="muted-empty">{t('local.evidence.noEvidence')}</div>}
    </section>}
    {tab === 'raw' && <RawInspectorContent node={node} records={rawRecords} loading={rawLoading} error={rawError}/>} 
  </Drawer>
}

