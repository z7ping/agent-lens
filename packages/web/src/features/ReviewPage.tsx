import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type {
  HubReadAvailability,
  HubReviewSessionSummaryDto,
  JsonValue,
  ReviewDetailFilter,
  ReviewEventNodeDto,
  ReviewInteractionDto,
  ReviewMessageNodeDto,
  ReviewNodeDto,
  ReviewSessionSummaryDto,
  SourceRecordResponseDto,
  ReviewToolNodeDto,
  TimelineEvidenceDto,
} from '@agent-lens/protocol'
import type { AgentLensClientModel } from '../client/model'
import { fetchHubReviewSessions } from '../client/hub-review'
import { piLiveApi } from '../client/pi-live'
import { useClientSnapshot } from '../App'
import { AgentScope, agentLabel, sourceDot } from '../components/AgentScope'
import { CopyableCodeBlock } from '../components/CopyableCodeBlock'
import { MarkdownContent } from '../components/MarkdownContent'
import { ToolKindIcon } from '../components/ToolKindIcon'
import { VirtualRoundMount } from '../components/VirtualRoundMount'
import { Button, Drawer, IconButton, Input, SelectMenu, StatusBadge, Toolbar, UiIcon } from '../components/ui'
import { historyTaskPresentation, sessionListTitle } from './task-center'
import { projectReviewInteractionPresentation, type ReviewProcessPresentationItem } from './review-interaction-presentation'
import { TaskEvent } from './TaskEvent'
import { TaskHeader } from './TaskHeader'
import { TaskMessage } from './TaskMessage'
import { TaskRound } from './TaskRound'
import { TaskSurface } from './TaskSurface'
import { TaskThinking } from './TaskThinking'
import { TaskToolGroup } from './TaskToolGroup'
import { agentLensI18n } from '../i18n/runtime'
import { workspaceDisplayName, type TaskDetailModel, type TaskRoundModel, type TaskThinkingModel, type TaskToolGroupModel, type TaskToolModel } from './task-detail-model'

function currentLocale(): string {
  return agentLensI18n.resolvedLanguage ?? agentLensI18n.language ?? 'zh-CN'
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(currentLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function formatClock(value: string): string {
  if (!value) return ''
  return new Intl.DateTimeFormat(currentLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value))
}

function formatHourMinute(value: string): string {
  if (!value) return ''
  return new Intl.DateTimeFormat(currentLocale(), { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat(currentLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)
}

function localDayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
}

type ReviewDayGroup = 'today' | 'yesterday' | 'earlier'

function sessionDayLabel(value: string, now = new Date()): ReviewDayGroup {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'earlier'
  const day = localDayStart(date)
  const today = localDayStart(now)
  if (day === today) return 'today'
  if (day === today - 86_400_000) return 'yesterday'
  return 'earlier'
}

function sessionRelativeTime(value: string, now = new Date()): string {
  const t = agentLensI18n.t.bind(agentLensI18n)
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  const group = sessionDayLabel(value, now)
  if (group === 'today') {
    const diff = Math.max(0, now.getTime() - date.getTime())
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 1) return t('review:local.time.justNow')
    if (minutes < 60) return t('review:local.time.minutesAgo', { count: minutes })
    const hours = Math.floor(diff / 3_600_000)
    if (hours <= 1) return t('review:local.time.aboutHourAgo')
    return t('review:local.time.hoursAgo', { count: hours })
  }
  if (group === 'yesterday') return t('review:local.time.yesterdayAt', { time: formatHourMinute(value) })
  if (date.getFullYear() === now.getFullYear()) return t('review:local.time.monthDayAt', { month: date.getMonth() + 1, day: date.getDate(), time: formatHourMinute(value) })
  return new Intl.DateTimeFormat(currentLocale(), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function duration(ms: number): string {
  const t = agentLensI18n.t.bind(agentLensI18n)
  const value = Math.max(0, ms)
  if (value < 1000) return t('review:local.duration.milliseconds', { value })
  if (value < 60_000) return t('review:local.duration.seconds', { value: (value / 1000).toFixed(value < 10_000 ? 1 : 0) })
  if (value < 3_600_000) return t('review:local.duration.minutes', { value: Math.round(value / 60_000) })
  if (value < 86_400_000) {
    const hours = value / 3_600_000
    return t('review:local.duration.hours', { value: hours < 10 ? hours.toFixed(1) : Math.round(hours) })
  }
  const days = value / 86_400_000
  return t('review:local.duration.days', { value: days < 10 ? days.toFixed(1) : Math.round(days) })
}

function elapsed(start: string, end: string): number {
  const value = Date.parse(end) - Date.parse(start)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function cleanSessionTitle(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

function compactTitle(value: string | undefined, max = 92, fallback = agentLensI18n.t('review:local.session.unnamed')): string {
  const text = cleanSessionTitle(value)
  if (!text) return fallback
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function hubAvailabilityString(value: HubReadAvailability): string | undefined {
  return value.state === 'value' && typeof value.value === 'string' && value.value.trim()
    ? value.value.trim()
    : undefined
}

function hubSessionTime(item: HubReviewSessionSummaryDto): string {
  return hubAvailabilityString(item.endedAt) ?? hubAvailabilityString(item.startedAt) ?? ''
}

function hubSessionTitle(item: HubReviewSessionSummaryDto): string {
  const value = hubAvailabilityString(item.title)
  if (value) return compactTitle(value, 74, agentLensI18n.t('review:local.session.remote'))
  if (item.title.state === 'redacted') return agentLensI18n.t('review:local.session.titleRedacted')
  if (item.title.state === 'omitted') return item.title.reason === 'policy'
    ? agentLensI18n.t('review:local.session.titleNotSynced')
    : agentLensI18n.t('review:local.session.remote')
  return agentLensI18n.t('review:local.session.remote')
}

function hubSessionVisibility(item: HubReviewSessionSummaryDto, review: ReturnType<AgentLensClientModel['getSnapshot']>['review']): boolean {
  if (review.filters.sourceIds !== null || review.filters.projectId || review.filters.status !== 'all') return false
  const search = review.filters.search.trim().toLowerCase()
  if (search && !hubSessionTitle(item).toLowerCase().includes(search) && !item.origin.nodeId.toLowerCase().includes(search)) return false
  const time = hubSessionTime(item)
  if (!time || review.filters.range === 'all') return true
  const at = Date.parse(time)
  if (!Number.isFinite(at)) return false
  const now = Date.now()
  if (review.filters.range === 'today') return localDayStart(new Date(at)) === localDayStart(new Date(now))
  const days = review.filters.range === '7d' ? 7 : 30
  return at >= now - days * 86_400_000
}

type UnifiedReviewSessionListEntry =
  | { origin: 'local'; id: string; activityAt: string; local: ReviewSessionSummaryDto }
  | { origin: 'remote'; id: string; activityAt: string; remote: HubReviewSessionSummaryDto }

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
  const parts = [agentLensI18n.t('review:local.event.runtimeResourceCounts', {
    contexts: arrayCount(record.contexts),
    skills: arrayCount(record.skills),
    prompts: arrayCount(record.prompts),
    extensions: arrayCount(record.extensions),
    themes: arrayCount(record.themes),
  })]
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

function runtimeStartupJson(value: JsonValue): string {
  const payload = payloadRecord(value)
  const resources = payload.resources
  if (resources === undefined) return ''
  const detail: Record<string, JsonValue> = { resources }
  for (const key of ['packageUpdateCheck', 'packageUpdates', 'packageUpdatesCheckedAt']) {
    const item = payload[key]
    if (item !== undefined) detail[key] = item
  }
  return JSON.stringify(detail, null, 2)
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

function EvidenceBadges({ evidence, compact = false }: { evidence: TimelineEvidenceDto[]; compact?: boolean }) {
  const { i18n } = useTranslation('review')
  const localeRevision = i18n.resolvedLanguage ?? i18n.language
  const visible = useMemo(() => {
    const seen = new Set<string>()
    const items: Array<{ key: string; label: string; confidence: string; title: string }> = []
    for (const item of evidence) {
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
  }, [evidence, compact, localeRevision])

  if (!visible.length) return null
  return <span className="evidence-inline-list">
    {visible.map(item => <span key={item.key} className="evidence-inline" data-confidence={item.confidence} title={item.title}>{item.label}</span>)}
    {evidence.length > visible.length && !compact && <span className="evidence-inline-more">+{evidence.length - visible.length}</span>}
  </span>
}

function sourceEventLabel(node: ReviewEventNodeDto): string {
  if (node.kind === 'runtime.startup') return agentLensI18n.t('review:local.event.runtimeStartupInfo')
  const payload = payloadRecord(node.payload)
  const action = stringValue(payload, 'action', 'event', 'type', 'status').toLowerCase()
  if (node.sourceId === 'codex') {
    if (node.kind === 'session.lifecycle' && action === 'turn.context') return agentLensI18n.t('review:local.event.codexTurnContext')
    if (node.kind === 'session.lifecycle' && action === 'turn.started') return agentLensI18n.t('review:local.event.codexTurnStarted')
    if (node.kind === 'session.lifecycle' && action === 'turn.completed') return agentLensI18n.t('review:local.event.codexTurnCompleted')
    if (node.kind === 'session.lifecycle' && action === 'turn.aborted') return agentLensI18n.t('review:local.event.codexTurnAborted')
    if (node.kind === 'session.lifecycle' && action === 'turn.error') return agentLensI18n.t('review:local.event.codexTurnError')
    if (node.kind === 'context.compaction') return agentLensI18n.t('review:local.event.contextCompaction')
    if (node.kind === 'context.injected') return agentLensI18n.t('review:local.event.injectedContext')
    if (node.kind === 'subagent.spawn') return agentLensI18n.t('review:local.event.subagentSpawn')
    if (node.kind === 'subagent.end') return agentLensI18n.t('review:local.event.subagentEnd')
    if (node.kind === 'permission.request') return agentLensI18n.t('review:local.event.permissionRequest')
    if (node.kind === 'session.lifecycle' && action.includes('stop')) return agentLensI18n.t('review:local.event.turnStop')
  }
  if (node.sourceId === 'claude-code') {
    if (node.kind === 'permission.request') return agentLensI18n.t('review:local.event.permissionRequest')
    if (node.kind === 'subagent.spawn') return agentLensI18n.t('review:local.event.subagentSpawn')
    if (node.kind === 'context.summary') return agentLensI18n.t('review:local.event.contextSummary')
    if (node.kind === 'context.compaction') return agentLensI18n.t('review:local.event.contextCompaction')
  }
  if (node.sourceId === 'pi') {
    if (node.kind === 'model.changed') return agentLensI18n.t('review:local.event.modelChanged')
    if (node.kind === 'context.compaction') return agentLensI18n.t('review:local.event.contextCompaction')
    if (node.kind === 'context.summary') return agentLensI18n.t('review:local.event.branchSummary')
  }
  return node.label
}

function sourceEventSummary(node: ReviewEventNodeDto): string {
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
    const path = stringValue(payload, 'path', 'filePath', 'file_path')
    return [action, path].filter(Boolean).join(' · ') || brief(payload, 100)
  }
  return action || brief(payload, 100)
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
  if (kind === 'shell') return agentLensI18n.t('review:local.tool.command')
  if (kind === 'read') return agentLensI18n.t('review:local.tool.read')
  if (kind === 'edit') return agentLensI18n.t('review:local.tool.edit')
  if (kind === 'search') return agentLensI18n.t('review:local.tool.search')
  if (kind === 'mcp') return agentLensI18n.t('review:local.tool.mcp')
  if (kind === 'web') return agentLensI18n.t('review:local.tool.web')
  return agentLensI18n.t('review:local.tool.generic')
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

function PrettyJson({ value }: { value: unknown }) {
  if (value === undefined) return <div className="muted-empty compact">{agentLensI18n.t('review:local.tool.noData')}</div>
  if (typeof value === 'string') return <CopyableCodeBlock className="tool-detail-code" copyValue={value}>{value}</CopyableCodeBlock>
  const text = JSON.stringify(value, null, 2)
  return <CopyableCodeBlock className="tool-detail-code" copyValue={text}>{text}</CopyableCodeBlock>
}

function StructuredToolDetail({ node }: { node: ReviewToolNodeDto }) {
  const info = toolPresentation(node)
  const input = toolInputRecord(node)
  const primaryLabel = info.kind === 'shell'
    ? agentLensI18n.t('review:local.tool.command')
    : info.kind === 'read' || info.kind === 'edit'
      ? agentLensI18n.t('review:local.tool.path')
      : info.kind === 'search'
        ? agentLensI18n.t('review:local.tool.query')
        : info.kind === 'mcp'
          ? agentLensI18n.t('review:local.tool.target')
          : info.kind === 'web'
            ? agentLensI18n.t('review:local.tool.addressQuery')
            : agentLensI18n.t('review:local.tool.inputSummary')
  const status = node.status === 'error'
    ? agentLensI18n.t('review:local.tool.statusError')
    : node.status === 'success'
      ? agentLensI18n.t('review:local.tool.statusSuccess')
      : node.status === 'running'
        ? agentLensI18n.t('review:local.tool.statusRunning')
        : agentLensI18n.t('review:local.tool.statusUnknown')
  return <section className="tool-detail">
    <div className="tool-detail-summary">
      <span className={`tool-detail-icon tool-kind-${info.kind}`}><ToolKindIcon kind={info.kind}/></span>
      <div><b>{node.name}</b><span>{info.label} · {status}{node.durationMs !== undefined && node.durationMs > 0 ? ` · ${duration(node.durationMs)}` : ''}</span></div>
    </div>
    {info.primary && <div className="tool-detail-section"><h4>{primaryLabel}</h4><CopyableCodeBlock className="tool-detail-code" copyValue={info.primary}>{info.primary}</CopyableCodeBlock></div>}
    {Object.keys(input).length > 0 && <div className="tool-detail-section"><h4>{agentLensI18n.t('review:local.tool.structuredInput')}</h4><PrettyJson value={node.input}/></div>}
    {node.output !== undefined && <div className={`tool-detail-section ${node.status === 'error' ? 'is-error' : ''}`}><h4>{node.status === 'error' ? agentLensI18n.t('review:local.tool.errorOutput') : agentLensI18n.t('review:local.tool.output')}</h4><PrettyJson value={node.output}/></div>}
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
        <div className="evidence-path">{agentLensI18n.t('review:local.event.locator')}：{JSON.stringify(record.locator)}</div>
        <CopyableCodeBlock className="raw-json" copyValue={JSON.stringify(record.payload, null, 2)}>{JSON.stringify(record.payload, null, 2)}</CopyableCodeBlock>
      </div>
    })}
    {!loading && !error && records.length === 0 && <>
      <div className="evidence-empty-detail">{agentLensI18n.t('review:local.event.rawMissing')}</div>
      <CopyableCodeBlock className="raw-json" copyValue={JSON.stringify(node.payload, null, 2)}>{JSON.stringify(node.payload, null, 2)}</CopyableCodeBlock>
    </>}
  </section>
}

function Inspector({ node, onClose, loadSourceRecord }: { node: ReviewNodeDto; onClose(): void; loadSourceRecord(id: string): Promise<SourceRecordResponseDto> }) {
  const { t } = useTranslation('review')
  const [tab, setTab] = useState<InspectorTab>('detail')
  const sourceRecordIds = useMemo(() => [...new Set(node.evidence.map(item => item.sourceRecordId).filter((id): id is string => Boolean(id)))], [node.evidence])
  const [rawRecords, setRawRecords] = useState<SourceRecordResponseDto[]>([])
  const [rawLoading, setRawLoading] = useState(false)
  const [rawError, setRawError] = useState('')

  useEffect(() => {
    if (tab !== 'raw') return
    let active = true
    setRawRecords([])
    setRawError('')
    if (!sourceRecordIds.length) return () => { active = false }
    setRawLoading(true)
    void Promise.all(sourceRecordIds.map(id => loadSourceRecord(id))).then(
      records => { if (active) { setRawRecords(records); setRawLoading(false) } },
      reason => { if (active) { setRawError(reason instanceof Error ? reason.message : String(reason)); setRawLoading(false) } },
    )
    return () => { active = false }
  }, [loadSourceRecord, node.id, sourceRecordIds, tab])

  const title = node.type === 'tool' ? node.name : node.type === 'event' ? sourceEventLabel(node) : roleLabel(node.role)
  const detailSummary = node.type === 'event'
    ? sourceEventSummary(node)
    : node.type === 'message'
      ? brief(node.text, 280)
      : ''
  const runtimeResources = node.type === 'event' && node.kind === 'runtime.startup'
    ? runtimeStartupJson(node.payload)
    : ''

  return <Drawer
    open
    className="review-inspector-overlay"
    title={title}
    description={t('local.event.detailDescription')}
    onClose={onClose}
  >
    <div className="agent-scope" role="tablist" aria-label={t('local.event.categoriesAria')}>
      <button className={`scope-chip ${tab === 'detail' ? 'scope-chip-active' : ''}`} role="tab" aria-selected={tab === 'detail'} onClick={() => setTab('detail')}>{t('local.event.detail')}</button>
      <button className={`scope-chip ${tab === 'evidence' ? 'scope-chip-active' : ''}`} role="tab" aria-selected={tab === 'evidence'} onClick={() => setTab('evidence')}>{t('local.event.evidence', { count: node.evidence.length })}</button>
      <button className={`scope-chip ${tab === 'raw' ? 'scope-chip-active' : ''}`} role="tab" aria-selected={tab === 'raw'} onClick={() => setTab('raw')}>{t('local.event.raw')}</button>
    </div>
    {tab === 'detail' && <>
      {node.type === 'tool' ? <StructuredToolDetail node={node}/> : <section className="inspector-section">
        <h3 className="section-label">{t('local.event.summary')}</h3>
        {runtimeResources
          ? <CopyableCodeBlock className="raw-json" copyValue={runtimeResources}>{runtimeResources}</CopyableCodeBlock>
          : node.type === 'event' && node.kind === 'context.injected' && stringValue(payloadRecord(node.payload), 'text')
            ? <CopyableCodeBlock className="injected-context-content" copyValue={stringValue(payloadRecord(node.payload), 'text')}>{stringValue(payloadRecord(node.payload), 'text')}</CopyableCodeBlock>
            : <div className="evidence-empty-detail">{detailSummary || t('local.event.noStructuredDetail')}</div>}
      </section>}
    </>}
    {tab === 'evidence' && <section className="inspector-section">
      <h3 className="section-label">{t('local.event.evidence', { count: node.evidence.length })}</h3>
      {node.evidence.length ? node.evidence.map(item => <div key={item.id} className="evidence-card">
        <div className="evidence-meta"><b>{evidenceLabel(evidenceCaptureKey, item.captureMethod)}</b><span>{evidenceLabel(evidenceDerivationKey, item.derivation)}</span><span>{t('local.evidence.confidenceLabel', { value: evidenceLabel(evidenceConfidenceKey, item.confidence) })}</span></div>
        <div className="evidence-path">{item.sourceLocator?.path ?? item.sourceRecordId ?? item.id}</div>
        {item.missingReason && <div className="evidence-missing">{t('local.evidence.incomplete')}</div>}
      </div>) : <div className="muted-empty">{t('local.evidence.noEvidence')}</div>}
    </section>}
    {tab === 'raw' && <RawInspectorContent node={node} records={rawRecords} loading={rawLoading} error={rawError}/>} 
  </Drawer>
}

function MarkdownSurface({ text }: { text: string }) {
  const { t } = useTranslation('review')
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
      {view === 'rendered' ? <MarkdownContent text={text}/> : <CopyableCodeBlock className="markdown-source" copyValue={text}>{text}</CopyableCodeBlock>}
      {collapsible && !expanded && <span className="markdown-fade" aria-hidden="true"/>}
    </div>
    <div className="markdown-message-actions">
      {collapsible && <button onClick={() => setExpanded(value => !value)}>{expanded ? t('local.markdown.collapseFiveLines') : t('local.markdown.expand')}</button>}
      <button title={view === 'rendered' ? t('local.markdown.viewSource') : t('local.markdown.returnRendered')} onClick={() => setView(value => value === 'rendered' ? 'source' : 'rendered')}>{view === 'rendered' ? t('local.markdown.source') : t('local.markdown.rendered')}</button>
    </div>
  </div>
}

function MessageBubble({
  node,
  inspect,
  nestedTools = [],
}: {
  node: ReviewMessageNodeDto
  inspect(node: ReviewNodeDto): void
  nestedTools?: ReviewToolNodeDto[]
}) {
  const { t } = useTranslation('review')
  if (node.role === 'reasoning' || node.role === 'commentary') {
    const label = node.role === 'commentary' ? t('local.process.execution') : t('local.process.thinking')
    const thinking: TaskThinkingModel = {
      id: node.id,
      label,
      text: node.text,
      preview: brief(node.text, 78),
      time: formatClock(node.at),
      state: 'settled',
    }
    return <TaskThinking
      model={thinking}
      defaultExpanded={false}
      meta={<EvidenceBadges evidence={node.evidence} compact/>}
      actions={node.evidence.length > 0 ? <button className="evidence-link" onClick={() => inspect(node)}>{t('local.evidence.allEvidence', { count: node.evidence.length })}</button> : undefined}
    >
      <MarkdownSurface text={node.text}/>
      {nestedTools.length > 0 && <ReviewToolGroupAdapter items={nestedTools} inspect={inspect}/>} 
    </TaskThinking>
  }

  return <TaskMessage
    role={node.role === 'user' ? 'user' : 'assistant'}
    text={node.text}
    author={node.role === 'user' ? t('local.role.you') : t('local.role.assistant')}
    time={formatClock(node.at)}
    meta={<EvidenceBadges evidence={node.evidence}/>}
    actions={node.evidence.length > 0 ? <button onClick={() => inspect(node)}>{t('local.evidence.evidenceDetail', { count: node.evidence.length })}</button> : undefined}
  />
}

function reviewToolModel(node: ReviewToolNodeDto): TaskToolModel {
  const info = toolPresentation(node)
  const status = node.status === 'error' ? 'error' : node.status === 'success' ? 'success' : node.status === 'running' ? 'running' : 'unknown'
  return {
    id: node.id,
    name: node.name,
    kind: info.kind,
    kindLabel: info.label,
    status,
    primary: info.primary || undefined,
    secondary: info.secondary || undefined,
    durationLabel: node.durationMs !== undefined && node.durationMs > 0 ? duration(node.durationMs) : formatClock(node.at),
  }
}

function ReviewToolGroupAdapter({ items, inspect }: { items: ReviewToolNodeDto[]; inspect(node: ReviewNodeDto): void }) {
  const { i18n } = useTranslation('review')
  const localeRevision = i18n.resolvedLanguage ?? i18n.language
  const model = useMemo<TaskToolGroupModel>(() => {
    const tools = items.map(reviewToolModel)
    const errorCount = tools.filter(tool => tool.status === 'error').length
    const totalDuration = items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0)
    const counts = new Map<ToolKind, number>()
    for (const tool of tools) counts.set(tool.kind, (counts.get(tool.kind) ?? 0) + 1)
    return {
      id: `tools:${items.map(item => item.id).join(':')}`,
      label: agentLensI18n.t('review:local.tool.execution'),
      itemCount: tools.length,
      errorCount,
      totalDurationLabel: totalDuration > 0 ? duration(totalDuration) : undefined,
      kindCounts: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([kind, count]) => ({ kind, label: toolKindLabel(kind), count })),
      tools,
    }
  }, [items, localeRevision])
  const nodes = useMemo(() => new Map(items.map(node => [node.id, node] as const)), [items])
  return <TaskToolGroup
    model={model}
    renderMeta={tool => {
      const node = nodes.get(tool.id)
      return node ? <EvidenceBadges evidence={node.evidence} compact/> : null
    }}
    onToolClick={tool => {
      const node = nodes.get(tool.id)
      if (node) inspect(node)
    }}
  />
}

function ReviewProcessGroup({
  id,
  items,
  inspect,
}: {
  id: string
  items: ReviewProcessPresentationItem[]
  inspect(node: ReviewNodeDto): void
}) {
  const messages = items.filter((item): item is Extract<typeof item, { type: 'message' }> => item.type === 'message')
  const first = messages[0]?.node
  const toolCount = items.reduce((count, item) => count + (item.type === 'tool-group' ? item.items.length : 0), 0)
  const model: TaskThinkingModel = {
    id,
    label: agentLensI18n.t('review:local.process.thinkingProcess'),
    text: first?.text ?? '',
    preview: brief(first?.text ?? agentLensI18n.t('review:local.tool.calls', { count: toolCount }), 78),
    time: first ? formatClock(first.at) : undefined,
    state: 'settled',
  }
  return <TaskThinking model={model} defaultExpanded={false} className="task-review-process">
    <div className="task-process-sequence">
      {items.map((item, index) => item.type === 'tool-group'
        ? <ReviewToolGroupAdapter key={`tools-${index}`} items={item.items} inspect={inspect}/>
        : <div className="task-process-message" data-message-role={item.node.role} key={item.node.id}>
            {item.node.role === 'reasoning' && <div className="task-process-message-kind">{agentLensI18n.t('review:local.process.thinking')}</div>}
            <MarkdownSurface text={item.node.text}/>
            <div className="task-process-message-meta"><EvidenceBadges evidence={item.node.evidence} compact/></div>
          </div>)}
    </div>
  </TaskThinking>
}

function EventRow({ event, inspect }: { event: ReviewEventNodeDto; inspect(node: ReviewNodeDto): void }) {
  return <TaskEvent
    model={{
      id: event.id,
      label: sourceEventLabel(event),
      category: event.category,
      summary: sourceEventSummary(event),
      sourceLabel: agentLabel(event.sourceId),
      time: formatClock(event.at),
      nativeId: event.nativeEventId,
      parentId: event.nativeParentEventId ?? event.parentObservationId,
    }}
    meta={<EvidenceBadges evidence={event.evidence} compact/>}
    onInspect={() => inspect(event)}
  />
}

function RawEventGroup({ items, inspect }: { items: ReviewEventNodeDto[]; inspect(node: ReviewNodeDto): void }) {
  const { t } = useTranslation('review')
  const [expanded, setExpanded] = useState(false)
  return <details className="raw-event-group" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>
      <UiIcon className="raw-event-group-chevron" name="chevron-right" size={14}/>
      <span className="raw-event-summary-copy">
        <span className="raw-event-summary-title">{t('local.rawEvents.title')} <span className="raw-event-summary-count">{items.length}</span></span>
        <small>{t('local.rawEvents.description')}</small>
      </span>
      <time>{formatClock(items[items.length - 1]?.at ?? '')}</time>
    </summary>
    {expanded && <div>{items.map(item => <EventRow key={item.id} event={item} inspect={inspect}/>)}</div>}
  </details>
}

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

function ReviewRoundAdapter({
  interaction,
  round,
  inspect,
  defaultExpanded,
  expansionStore,
  forceExpanded,
  forceRevision,
  showAllEvents,
}: {
  interaction: ReviewInteractionDto
  round: TaskRoundModel
  inspect(node: ReviewNodeDto): void
  defaultExpanded: boolean
  expansionStore: Map<string, boolean>
  forceExpanded: boolean
  forceRevision: number
  showAllEvents: boolean
}) {
  const groups = useMemo(() => projectReviewInteractionPresentation(interaction.nodes), [interaction.nodes])

  return <TaskRound
    model={round}
    defaultExpanded={defaultExpanded}
    expansionStore={expansionStore}
    forceExpanded={forceExpanded}
    forceRevision={forceRevision}
  >
    {groups.map((entry, index) => {
      if (entry.type === 'process') return <ReviewProcessGroup key={entry.id} id={entry.id} items={entry.items} inspect={inspect}/>
      if (entry.type === 'tool-group') return <ReviewToolGroupAdapter key={`tools-${index}`} items={entry.items} inspect={inspect}/>
      if (entry.type === 'raw-event-group') return showAllEvents ? <RawEventGroup key={`raw-${index}`} items={entry.items} inspect={inspect}/> : null
      if (entry.type === 'reasoning') return <MessageBubble key={entry.node.id} node={entry.node} nestedTools={entry.tools} inspect={inspect}/>
      if (entry.type === 'message') return <MessageBubble key={entry.node.id} node={entry.node} inspect={inspect}/>
      return <EventRow key={entry.node.id} event={entry.node} inspect={inspect}/>
    })}
  </TaskRound>
}

type RoundFilter = ReviewDetailFilter

interface ReviewReaderPosition {
  interactionId: string
  offset: number
  scrollTop: number
}

function captureReviewReaderPosition(pane: HTMLElement): ReviewReaderPosition {
  const paneTop = pane.getBoundingClientRect().top
  let anchor: HTMLElement | null = null
  for (const element of pane.querySelectorAll<HTMLElement>('.virtual-round-shell[data-interaction-id]')) {
    const top = element.getBoundingClientRect().top
    if (top <= paneTop + 56) anchor = element
    else if (!anchor) {
      anchor = element
      break
    } else break
  }
  return {
    interactionId: anchor?.dataset.interactionId ?? '',
    offset: anchor ? anchor.getBoundingClientRect().top - paneTop : 0,
    scrollTop: pane.scrollTop,
  }
}

function restoreReviewReaderPosition(pane: HTMLElement, saved: ReviewReaderPosition): boolean {
  if (!saved.interactionId) {
    pane.scrollTop = saved.scrollTop
    return true
  }
  const anchor = [...pane.querySelectorAll<HTMLElement>('.virtual-round-shell[data-interaction-id]')]
    .find(element => element.dataset.interactionId === saved.interactionId)
  if (!anchor) return false
  const paneTop = pane.getBoundingClientRect().top
  pane.scrollTop += anchor.getBoundingClientRect().top - paneTop - saved.offset
  return true
}

function highLatencyThreshold(interactions: ReviewInteractionDto[]): number | null {
  const values = interactions.map(item => elapsed(item.startedAt, item.endedAt)).filter(value => value > 0).sort((a, b) => a - b)
  if (values.length < 2) return null
  const middle = Math.floor(values.length / 2)
  const median = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2
  const upperIndex = Math.min(values.length - 1, Math.floor((values.length - 1) * 0.75))
  const upperQuartile = values[upperIndex]!
  return Math.max(upperQuartile, median * 1.75)
}

export function ReviewPage({
  model,
  embedded = false,
  onResumePiSession,
  resumingPiSession = false,
  piResumeError = '',
}: {
  model: AgentLensClientModel
  embedded?: boolean
  onResumePiSession?(logicalSessionId: string): void | Promise<void>
  resumingPiSession?: boolean
  piResumeError?: string
}) {
  const { t } = useTranslation('review')
  const snapshot = useClientSnapshot(model)
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const [inspect, setInspect] = useState<ReviewNodeDto | null>(null)
  const [roundFilter, setRoundFilter] = useState<RoundFilter>('all')
  const [roundFilterLoading, setRoundFilterLoading] = useState(false)
  const [expandAllRounds, setExpandAllRounds] = useState(true)
  const [roundExpansionRevision, setRoundExpansionRevision] = useState(0)
  const [showAllEvents, setShowAllEvents] = useState(true)
  const [hubSessions, setHubSessions] = useState<HubReviewSessionSummaryDto[]>([])
  const [forkingPiSessionId, setForkingPiSessionId] = useState('')
  const [piForkError, setPiForkError] = useState<{ sessionId: string; message: string } | null>(null)
  const sessionLoadSentinelRef = useRef<HTMLButtonElement>(null)
  const detailLoadSentinelRef = useRef<HTMLDivElement>(null)
  const readerPaneRef = useRef<HTMLDivElement>(null)
  const readerPositionsRef = useRef(new Map<string, ReviewReaderPosition>())
  const pendingReaderAnchorRef = useRef<{ position: ReviewReaderPosition; userRevision: number } | null>(null)
  const readerUserRevisionRef = useRef(0)
  const detailAutoLoadBaselineRef = useRef(0)
  const followingTailRef = useRef(false)
  const roundExpansionRef = useRef(new Map<string, boolean>())
  const review = snapshot.review
  const agents = snapshot.facets?.agents ?? []
  const projects = snapshot.facets?.projects ?? []
  const detail = review.detail
  const visibleHubSessions = useMemo(() => hubSessions.filter(item => hubSessionVisibility(item, review)), [hubSessions, review.filters, t])
  const sessionGroups = useMemo(() => {
    const groups = new Map<ReviewDayGroup, UnifiedReviewSessionListEntry[]>()
    const now = new Date()
    const combined: UnifiedReviewSessionListEntry[] = [
      ...(review.response?.items ?? []).map(item => ({ origin: 'local' as const, id: item.id, activityAt: item.endedAt || item.startedAt, local: item })),
      ...visibleHubSessions.map(item => ({ origin: 'remote' as const, id: item.id, activityAt: hubSessionTime(item), remote: item })),
    ].sort((left, right) => {
      const leftAt = Date.parse(left.activityAt)
      const rightAt = Date.parse(right.activityAt)
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt != rightAt) return rightAt - leftAt
      if (Number.isFinite(leftAt) && !Number.isFinite(rightAt)) return -1
      if (!Number.isFinite(leftAt) && Number.isFinite(rightAt)) return 1
      return left.id.localeCompare(right.id)
    })
    for (const item of combined) {
      const label = sessionDayLabel(item.activityAt, now)
      const items = groups.get(label) ?? []
      items.push(item)
      groups.set(label, items)
    }
    return [...groups.entries()].map(([key, items]) => ({
      key,
      label: t(`local.day.${key}`),
      items,
    }))
  }, [review.response?.items, visibleHubSessions, t])

  useEffect(() => {
    if (embedded) {
      setHubSessions([])
      return
    }
    let cancelled = false
    void fetchHubReviewSessions(200).then(
      value => { if (!cancelled) setHubSessions(value.items.filter(item => item.origin.kind === 'remote')) },
      () => { if (!cancelled) setHubSessions([]) },
    )
    return () => { cancelled = true }
  }, [embedded, review.response?.meta.generatedAt])

  useEffect(() => {
    if (!sessionId || (sessionId === review.selectedId && (review.detailLoading || review.detail?.id === sessionId || review.error))) return
    readerPositionsRef.current.delete(sessionId)
    void model.selectReviewSession(sessionId)
  }, [sessionId, review.selectedId, review.detail?.id, review.detailLoading, review.error, model])
  useEffect(() => {
    roundExpansionRef.current.clear()
    setRoundFilter('all')
    setRoundFilterLoading(false)
    setExpandAllRounds(true)
    setRoundExpansionRevision(0)
    setShowAllEvents(true)
    setInspect(null)
    setPiForkError(null)
    followingTailRef.current = false
    detailAutoLoadBaselineRef.current = readerUserRevisionRef.current
  }, [detail?.id])
  useEffect(() => {
    if (detail?.page.filter) setRoundFilter(detail.page.filter)
  }, [detail?.page.filter])

  useLayoutEffect(() => {
    const pending = pendingReaderAnchorRef.current
    if (!pending) return
    if (pending.userRevision !== readerUserRevisionRef.current) return
    const frame = window.requestAnimationFrame(() => {
      const pane = readerPaneRef.current
      if (!pane || pending.userRevision !== readerUserRevisionRef.current) return
      if (pendingReaderAnchorRef.current !== pending) return
      pendingReaderAnchorRef.current = null
      restoreReviewReaderPosition(pane, pending.position)
    })
    return () => window.cancelAnimationFrame(frame)
  })

  useLayoutEffect(() => {
    if (!detail || review.detailLoading || detail.page.filter !== 'all' || detail.page.direction !== 'backward') return
    const frame = window.requestAnimationFrame(() => {
      const pane = readerPaneRef.current
      if (!pane) return
      pane.scrollTop = pane.scrollHeight
      followingTailRef.current = true
      model.acknowledgeReviewNewData()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [detail?.id, detail?.page.direction, detail?.page.filter, review.detailLoading, model])

  useEffect(() => {
    const id = detail?.id
    if (!id || review.detailLoading) return
    const saved = readerPositionsRef.current.get(id)
    if (!saved || saved.scrollTop <= 0) return
    let cancelled = false
    const nextFrame = () => new Promise<void>(resolve => window.requestAnimationFrame(() => resolve()))
    const restore = async () => {
      await nextFrame()
      for (let attempt = 0; attempt < 25 && !cancelled; attempt += 1) {
        const pane = readerPaneRef.current
        if (!pane) return
        if (restoreReviewReaderPosition(pane, saved)) return
        const current = model.getSnapshot().review
        if (!saved.interactionId || current.selectedId !== id || !current.detail?.page.hasMore || current.detail.page.direction !== 'forward' || current.detail.page.filter !== 'all') break
        await model.loadMoreReviewDetail()
        await nextFrame()
      }
      if (!cancelled && readerPaneRef.current) readerPaneRef.current.scrollTop = saved.scrollTop
    }
    void restore()
    return () => { cancelled = true }
  }, [detail?.id, review.detailLoading, model])

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

  const loadOlder = useCallback(async () => {
    const pane = readerPaneRef.current
    if (!pane || review.detailLoadingMore) return
    const saved = captureReviewReaderPosition(pane)
    const userRevision = readerUserRevisionRef.current
    await model.loadMoreReviewDetail()
    window.requestAnimationFrame(() => {
      const current = readerPaneRef.current
      if (!current || userRevision !== readerUserRevisionRef.current) return
      restoreReviewReaderPosition(current, saved)
    })
  }, [model, review.detailLoadingMore])

  const loadFollowing = useCallback(async () => {
    const pane = readerPaneRef.current
    if (!pane || review.detailLoadingMore) return
    const saved = captureReviewReaderPosition(pane)
    const userRevision = readerUserRevisionRef.current
    await model.loadMoreReviewDetail()
    window.requestAnimationFrame(() => {
      const current = readerPaneRef.current
      if (!current || userRevision !== readerUserRevisionRef.current) return
      restoreReviewReaderPosition(current, saved)
    })
  }, [model, review.detailLoadingMore])

  useEffect(() => {
    const sentinel = detailLoadSentinelRef.current
    // backward 方向仍只允许显式加载，避免顶部插入内容时抢滚动。
    // forward 方向既监听交叉，也监听真实滚动：用户意图保存在 ref 中，
    // 如果 sentinel 已经位于 rootMargin 内，仅修改 ref 不会让 IntersectionObserver
    // 再触发；滚动监听负责补上这条缺失信号，同时 baseline 继续阻止程序性跳转
    // 自动把整场会话一次性拉完。
    if (!sentinel || !detail?.page.hasMore || detail.page.direction !== 'forward' || review.detailLoadingMore || review.error) return
    const root = sentinel.closest('.review-reader-pane') as HTMLElement | null
    if (!root) return
    let pending = false
    const maybeLoadFollowing = () => {
      if (pending || readerUserRevisionRef.current <= detailAutoLoadBaselineRef.current) return
      const rootBounds = root.getBoundingClientRect()
      const sentinelBounds = sentinel.getBoundingClientRect()
      if (sentinelBounds.top > rootBounds.bottom + 800 || sentinelBounds.bottom < rootBounds.top - 800) return
      pending = true
      void loadFollowing().finally(() => { pending = false })
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) maybeLoadFollowing()
    }, { root, rootMargin: '800px 0px' })
    observer.observe(sentinel)
    root.addEventListener('scroll', maybeLoadFollowing, { passive: true })
    return () => {
      observer.disconnect()
      root.removeEventListener('scroll', maybeLoadFollowing)
    }
  }, [detail?.id, detail?.page.hasMore, detail?.page.nextCursor, detail?.page.direction, review.detailLoadingMore, review.error, loadFollowing])

  const select = (id: string) => {
    const pane = readerPaneRef.current
    if (detail?.id && pane) readerPositionsRef.current.set(detail.id, captureReviewReaderPosition(pane))
    readerPositionsRef.current.delete(id)
    void model.selectReviewSession(id)
    navigate(`/review/${encodeURIComponent(id)}`)
  }
  const scrollToBoundary = (boundary: 'top' | 'bottom') => {
    const pane = readerPaneRef.current
    if (!pane) return
    pane.style.setProperty('overflow-anchor', 'none')
    const apply = () => { pane.scrollTop = boundary === 'top' ? 0 : pane.scrollHeight }
    let remainingFrames = 30
    let stableFrames = 0
    let previousHeight = -1
    const settle = () => {
      apply()
      const height = pane.scrollHeight
      stableFrames = height === previousHeight ? stableFrames + 1 : 0
      previousHeight = height
      remainingFrames -= 1
      if (stableFrames >= 3 || remainingFrames <= 0) {
        pane.style.removeProperty('overflow-anchor')
        return
      }
      window.requestAnimationFrame(settle)
    }
    apply()
    window.requestAnimationFrame(settle)
    if (boundary === 'bottom') {
      followingTailRef.current = true
      model.acknowledgeReviewNewData()
    }
  }
  const scrollTop = () => scrollToBoundary('top')
  const scrollBottom = () => scrollToBoundary('bottom')

  const selectRoundFilter = async (filter: RoundFilter) => {
    if (!detail || roundFilterLoading) return
    const selectedId = detail.id
    pendingReaderAnchorRef.current = null
    detailAutoLoadBaselineRef.current = readerUserRevisionRef.current
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
    pendingReaderAnchorRef.current = null
    detailAutoLoadBaselineRef.current = readerUserRevisionRef.current
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

  const showFromStart = async () => {
    if (!detail || roundFilterLoading) return
    const selectedId = detail.id
    pendingReaderAnchorRef.current = null
    detailAutoLoadBaselineRef.current = readerUserRevisionRef.current
    setRoundFilterLoading(true)
    try {
      await model.showReviewFromStart()
      if (model.getSnapshot().review.selectedId === selectedId) {
        setRoundFilter('all')
        scrollTop()
      }
    } finally {
      if (model.getSnapshot().review.selectedId === selectedId) setRoundFilterLoading(false)
    }
  }

  const threshold = useMemo(() => {
    if (!detail) return null
    if (detail.page.latencyThresholdMs !== undefined) return detail.page.latencyThresholdMs
    if (detail.page.filter === 'all' && detail.page.direction === 'forward' && !detail.page.hasMore) {
      return highLatencyThreshold(detail.interactions)
    }
    return null
  }, [detail])
  const taskDetailModel = useMemo<TaskDetailModel | null>(() => {
    if (!detail) return null
    const rounds: TaskRoundModel[] = detail.interactions.map(interaction => {
      const stats = interactionStats(interaction)
      return {
        id: interaction.id,
        ordinal: interaction.ordinal,
        label: interaction.trigger === 'background'
          ? t('local.interaction.background')
          : t('local.interaction.round', { count: interaction.ordinal }),
        state: 'settled',
        preview: stats.preview || undefined,
        toolCount: stats.toolCount,
        errorCount: stats.errorCount,
        durationMs: stats.durationMs,
        highLatency: detail.page.filter === 'latency' || (threshold !== null && stats.durationMs >= threshold),
      }
    })
    const title = historyTaskPresentation(
      detail,
      detail.projectName
        ? t('local.interaction.projectSession', { project: detail.projectName })
        : t('local.interaction.agentSession', { agent: agentLabel(detail.sourceIds[0] ?? '') }),
    ).title
    return {
      id: detail.id,
      title,
      agentLabel: detail.sourceIds.map(id => agentLabel(id)).join(' / '),
      projectLabel: detail.projectName,
      statusLabel: detail.errorCount > 0 ? t('local.interaction.errors') : undefined,
      startedAt: detail.startedAt,
      endedAt: detail.endedAt,
      workspacePath: detail.workspacePath,
      metrics: [
        { value: detail.interactionCount, label: t('local.interaction.metricRounds') },
        { value: detail.toolCount, label: t('local.interaction.metricCalls') },
        ...(detail.errorCount > 0 ? [{ value: detail.errorCount, label: t('local.interaction.metricErrors'), tone: 'danger' as const }] : []),
        { value: duration(detail.durationMs), label: t('local.interaction.metricSpan') },
      ],
      rounds,
    }
  }, [detail, threshold, t])
  const annotatedInteractions = useMemo(() => {
    if (!detail || !taskDetailModel) return []
    const byId = new Map(detail.interactions.map(interaction => [interaction.id, interaction] as const))
    return taskDetailModel.rounds.flatMap(round => {
      const interaction = byId.get(round.id)
      return interaction ? [{ interaction, round }] : []
    })
  }, [detail, taskDetailModel])
  const pageIncomplete = detail?.page.hasMore ?? false
  const isBackward = detail?.page.direction === 'backward'
  const isFiltered = roundFilter !== 'all'
  const atStart = roundFilter === 'all' && !isBackward

  const onReaderScroll = () => {
    const pane = readerPaneRef.current
    if (!pane) return
    if (detail?.id) {
      const previous = readerPositionsRef.current.get(detail.id)
      readerPositionsRef.current.set(detail.id, {
        interactionId: previous?.interactionId ?? '',
        offset: previous?.offset ?? 0,
        scrollTop: pane.scrollTop,
      })
    }
    followingTailRef.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 180
  }

  const emptyLabel = roundFilter === 'errors'
    ? t('local.interaction.noErrors')
    : roundFilter === 'latency'
      ? t('local.interaction.noLatency')
      : t('local.interaction.noMatches')

  const toggleRoundExpansion = () => {
    const pane = readerPaneRef.current
    if (pane) pendingReaderAnchorRef.current = {
      position: captureReviewReaderPosition(pane),
      userRevision: readerUserRevisionRef.current,
    }
    setExpandAllRounds(value => !value)
    setRoundExpansionRevision(value => value + 1)
  }

  const toggleEventVisibility = () => {
    const pane = readerPaneRef.current
    if (pane) pendingReaderAnchorRef.current = {
      position: captureReviewReaderPosition(pane),
      userRevision: readerUserRevisionRef.current,
    }
    setShowAllEvents(value => !value)
  }

  const noteReaderUserIntent = () => {
    readerUserRevisionRef.current += 1
    pendingReaderAnchorRef.current = null
  }

  const forkPiSession = async (logicalSessionId: string) => {
    if (forkingPiSessionId || resumingPiSession) return
    setForkingPiSessionId(logicalSessionId)
    setPiForkError(null)
    try {
      const state = await piLiveApi.fork(logicalSessionId)
      navigate(`/review/live/${encodeURIComponent(state.runtimeSessionId)}`)
    } catch (reason) {
      setPiForkError({ sessionId: logicalSessionId, message: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      setForkingPiSessionId('')
    }
  }

  return <main className={`review-page ${embedded ? 'review-page-embedded' : ''}`}>
    {!embedded && <Toolbar className="workspace-toolbar" aria-label={t('local.filters.toolbarAria')}>
      <AgentScope agents={agents} value={review.filters.sourceIds?.[0] ?? ''} onChange={sourceId => model.setReviewFilters({ sourceIds: sourceId ? [sourceId] : [] })}/>
      <span className="toolbar-divider" />
      <SelectMenu className="filter" value={review.filters.projectId} onChange={projectId => model.setReviewFilters({ projectId })} ariaLabel={t('local.filters.projectAria')} placeholder={t('local.filters.allProjects')} menuWidth={280} searchable searchPlaceholder={t('local.filters.searchProject')} options={[
        { value: '', label: t('local.filters.allProjects') },
        ...projects.map(project => ({ value: project.id, label: project.name ?? project.repositoryIdentity ?? project.id, description: project.repositoryIdentity ?? undefined })),
      ]}/>
      <SelectMenu className="filter" value={review.filters.range} onChange={range => model.setReviewFilters({ range: range as typeof review.filters.range })} ariaLabel={t('local.filters.timeAria')} menuWidth={156} options={[
        { value: 'today', label: t('local.filters.today') }, { value: '7d', label: t('local.filters.sevenDays') }, { value: '30d', label: t('local.filters.thirtyDays') }, { value: 'all', label: t('local.filters.allTime') },
      ]}/>
      <SelectMenu className="filter" value={review.filters.status} onChange={status => model.setReviewFilters({ status: status as typeof review.filters.status })} ariaLabel={t('local.filters.statusAria')} menuWidth={150} options={[
        { value: 'all', label: t('local.filters.allStatus') }, { value: 'clean', label: t('local.filters.clean') }, { value: 'with-errors', label: t('local.filters.withErrors') },
      ]}/>
      <Input className="filter search-filter" placeholder={t('local.filters.searchPlaceholder')} value={review.filters.search} onChange={e => model.setReviewFilters({ search: e.target.value })}/>
      <IconButton onClick={() => void model.refreshReview()} title={t('local.filters.refresh')} aria-label={t('local.filters.refresh')}><UiIcon name="refresh" size={16}/></IconButton>
    </Toolbar>}

    <div className="review-layout">
      {!embedded && <aside className="session-panel">
        <div className="session-panel-head"><div><b>{t('local.list.sessions')}</b><span>{t('local.list.ordering')}</span></div><span className="count-badge">{(review.response?.items.length ?? 0) + visibleHubSessions.length}{review.response?.meta.hasMore ? '+' : ''}</span></div>
        <div className="session-scroll">
          {review.loading && !review.response && <div className="empty-state">{t('local.list.loading')}</div>}
          {sessionGroups.map(group => <section className="session-group-block" key={group.key}>
            <div className="session-group">{group.label}</div>
            {group.items.map(entry => entry.origin === 'local' ? (() => {
              const item = entry.local
              const presentation = historyTaskPresentation(
                item,
                item.projectName
                  ? t('local.session.projectSession', { project: item.projectName })
                  : t('local.session.agentSession', { agent: agentLabel(item.sourceIds[0] ?? '', item.productId) }),
              )
              return <button key={`local:${item.id}`} className={`session-item ${review.selectedId === item.id ? 'session-item-active' : ''}`} onClick={() => select(item.id)}>
                <div className="session-item-title-row"><div className="session-item-title" title={presentation.title}>{sessionListTitle(presentation.title, t('local.session.agentSession', { agent: agentLabel(item.sourceIds[0] ?? '', item.productId) }), item.sourceIds)}</div>{item.sourceIds.includes('pi') ? <StatusBadge tone="success">{t('local.session.resumable')}</StatusBadge> : presentation.activityLabel && <StatusBadge className="session-activity-badge">{presentation.activityLabel}</StatusBadge>}</div>
                <div className="session-item-meta"><span className={`source-dot ${sourceDot(item.sourceIds[0] ?? '')}`}/><span>{agentLabel(item.sourceIds[0] ?? '', item.productId)}</span><span className="session-item-project">{item.projectName ?? item.workspacePath?.split(/[\\/]/).pop() ?? t('local.session.noProject')}</span><time title={t('local.list.recentActivity', { time: formatTime(entry.activityAt) })}>{sessionRelativeTime(entry.activityAt)}</time></div>
              </button>
            })() : (() => {
              const item = entry.remote
              const time = hubSessionTime(item)
              return <button key={`remote:${item.id}`} className="session-item" onClick={() => navigate(`/review/hub/${encodeURIComponent(item.id)}`)}>
                <div className="session-item-title-row"><div className="session-item-title" title={hubSessionTitle(item)}>{sessionListTitle(hubSessionTitle(item), t('local.session.remote'))}</div></div>
                <div className="session-item-meta"><span className="hub-session-source remote">{t('local.session.remoteSource', { node: item.origin.nodeId })}</span><time title={time || t('local.session.timeNotSynced')}>{time ? sessionRelativeTime(time) : t('local.session.timeNotSynced')}</time></div>
              </button>
            })())}
          </section>)}
          {review.response?.meta.hasMore && <button ref={sessionLoadSentinelRef} className="session-load-more" disabled={review.loadingMore} onClick={() => void model.loadMoreReview()}>{review.loadingMore ? t('local.list.loadMoreLoading') : review.error ? t('local.list.loadMoreFailed') : t('local.list.loadMoreAuto')}</button>}
          {review.response && !review.response.meta.hasMore && review.response.items.length > 0 && <div className="session-load-more" aria-live="polite">{t('local.list.allLoaded')}</div>}
          {!review.loading && !review.response?.items.length && !visibleHubSessions.length && <div className="empty-state">{t('local.list.empty')}</div>}
        </div>
      </aside>}

      <TaskSurface
        mode="review"
        className="review-session-view"
        boundaryNavigation={detail ? {
          startDisabled: roundFilterLoading || atStart,
          endDisabled: roundFilterLoading,
          onStart: showFromStart,
          onEnd: jumpToLatest,
        } : undefined}
      >
        {detail && <TaskHeader
          marker={<span className={`source-dot ${sourceDot(detail.sourceIds[0] ?? '')}`}/>}
          agent={taskDetailModel?.agentLabel ?? ''}
          context={taskDetailModel?.projectLabel ?? workspaceDisplayName(taskDetailModel?.workspacePath) ?? t('local.session.unlinkedProject')}
          showStatus={false}
          title={<span title={taskDetailModel?.title}>{compactTitle(taskDetailModel?.title, 15)}</span>}
          metrics={[]}
          infoItems={taskDetailModel?.startedAt && taskDetailModel.endedAt ? [
            { label: t('local.header.project'), value: taskDetailModel.projectLabel ?? t('local.session.unlinkedProject') },
            { label: t('local.header.startTime'), value: formatDateTime(taskDetailModel.startedAt) },
            { label: t('local.header.endTime'), value: formatDateTime(taskDetailModel.endedAt) },
            { label: t('local.header.duration'), value: duration(detail.durationMs) },
            ...(taskDetailModel.workspacePath ? [{ label: t('local.header.workspace'), value: <code title={taskDetailModel.workspacePath}>{taskDetailModel.workspacePath}</code> }] : []),
            ...taskDetailModel.metrics.filter(metric => metric.label !== t('local.interaction.metricSpan')).map(metric => ({ label: metric.label, value: metric.value, tone: metric.tone })),
          ] : []}
          actions={<>
            {onResumePiSession && detail.sourceIds.includes('pi') ? <>
              <Button size="small" loading={resumingPiSession} disabled={resumingPiSession || Boolean(forkingPiSessionId)} onClick={() => void onResumePiSession(detail.id)}><UiIcon name="arrow-right" size={14}/>{resumingPiSession ? t('local.header.openingPi') : t('local.header.continueSession')}</Button>
              <Button size="small" loading={forkingPiSessionId === detail.id} disabled={resumingPiSession || Boolean(forkingPiSessionId)} onClick={() => void forkPiSession(detail.id)}><UiIcon name="plus" size={14}/>{t('local.header.forkContinue')}</Button>
              {resumingPiSession && <StatusBadge tone="accent" dot role="status">{t('local.header.preparingHistory')}</StatusBadge>}
              {piResumeError && <StatusBadge tone="danger" title={piResumeError}>{t('local.header.continueFailed', { error: piResumeError })}</StatusBadge>}
            </> : null}
            <button className="review-audit-toggle" aria-pressed={showAllEvents} onClick={toggleEventVisibility}>{showAllEvents ? t('local.header.viewAll') : t('local.header.viewCore')}</button>
          </>}
        />}

        <div
          ref={readerPaneRef}
          className="review-reader-pane"
          onScroll={onReaderScroll}
          onWheelCapture={noteReaderUserIntent}
          onTouchStartCapture={noteReaderUserIntent}
          onPointerDownCapture={noteReaderUserIntent}
          onKeyDownCapture={noteReaderUserIntent}
        >
          {review.error && <div className="page-error">{review.error}</div>}
          {!detail ? <div className="empty-state fill">{review.selectedId && review.detailLoading ? t('local.empty.loadingDetail') : t('local.empty.selectSession')}</div> : <div className="review-reader">
            {(piResumeError || (piForkError?.sessionId === detail.id ? piForkError.message : '')) && <div className="page-error" role="alert">{piResumeError || piForkError?.message}</div>}

            {detail.sourceIds.includes('pi') && review.relationships?.items.length ? <details className="pi-session-tree">
              <summary><UiIcon className="pi-session-tree-chevron" name="chevron-right" size={14}/><span>{t('local.relationship.piTree', { count: review.relationships.items.length })}</span></summary>
              <div>{review.relationships.items.map(item => <div key={item.id}>{item.fromNativeSessionId ?? item.fromSessionId} <span><UiIcon name="arrow-right" size={14}/></span> {item.toNativeSessionId ?? item.toSessionId}</div>)}</div>
            </details> : null}

            <div className="round-nav" aria-label={t('local.roundNav.aria')}>
              <div className="round-nav-filters" aria-label={t('local.roundNav.filterAria')}>
                <button className={roundFilter === 'all' && !isBackward ? 'active' : ''} disabled={roundFilterLoading} onClick={() => void selectRoundFilter('all')}>{t('local.roundNav.all')} {roundFilter === 'all' && !isBackward && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</button>
                <button className={roundFilter === 'errors' ? 'active' : ''} disabled={roundFilterLoading} onClick={() => void selectRoundFilter('errors')}>{t('local.roundNav.errors')} {roundFilter === 'errors' && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</button>
                <button className={roundFilter === 'latency' ? 'active' : ''} disabled={roundFilterLoading} onClick={() => void selectRoundFilter('latency')}>{t('local.roundNav.latency')} {roundFilter === 'latency' && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</button>
              </div>
              <div className="round-nav-actions" aria-label={t('local.roundNav.actionsAria')}>
                <button className="round-nav-expand" disabled={roundFilterLoading} onClick={toggleRoundExpansion}>{expandAllRounds ? t('local.roundNav.collapsePage') : t('local.roundNav.expandPage')}</button>
                {review.detailHasNewData && <button className="round-nav-live" onClick={() => void jumpToLatest()}>{t('local.roundNav.newRecords')} <UiIcon name="arrow-down" size={14}/></button>}
              </div>
              {roundFilterLoading && <span className="round-nav-status">{t('local.roundNav.querying')}</span>}
              <small>{t('local.roundNav.latencyNote')}</small>
            </div>

            <div className="review-flow">
              {isBackward && roundFilter === 'all' && pageIncomplete && <div ref={detailLoadSentinelRef} className="detail-load-sentinel detail-load-sentinel-top" aria-live="polite">
                {review.detailLoadingMore ? t('local.roundNav.loadingOlder') : review.error ? <button onClick={() => void loadOlder()}>{t('local.roundNav.loadFailedRetry')}</button> : <button onClick={() => void loadOlder()}>{t('local.roundNav.loadOlder')}</button>}
              </div>}
              {annotatedInteractions.map((item, index) => <VirtualRoundMount
                key={item.round.id}
                eager={index < 6 || item.round.id === annotatedInteractions.at(-1)?.round.id}
                retainMounted
                estimate={item.round.toolCount > 12 ? 420 : item.round.toolCount > 4 ? 300 : 220}
              >
                <ReviewRoundAdapter
                  interaction={item.interaction}
                  round={item.round}
                  defaultExpanded={expandAllRounds}
                  expansionStore={roundExpansionRef.current}
                  forceExpanded={expandAllRounds}
                  forceRevision={roundExpansionRevision}
                  showAllEvents={showAllEvents}
                  inspect={setInspect}
                />
              </VirtualRoundMount>)}
              {!annotatedInteractions.length && <div className="round-filter-empty">{emptyLabel}</div>}
              {!isBackward && roundFilter !== 'latest' && <div ref={detailLoadSentinelRef} className="detail-load-sentinel" aria-live="polite">
                {review.detailLoadingMore
                  ? t('local.roundNav.loadingFollowing', { scope: isFiltered ? t('local.roundNav.followingMatches') : t('local.roundNav.following') })
                  : detail.page.hasMore
                    ? review.error
                      ? <button onClick={() => void loadFollowing()}>{t('local.roundNav.loadFailedRetry')}</button>
                      : t('local.roundNav.autoLoadFollowing', { scope: isFiltered ? t('local.roundNav.followingMatches') : t('local.roundNav.following') })
                    : isFiltered
                      ? t('local.roundNav.allMatchesLoaded', { count: detail.interactions.length })
                      : t('local.roundNav.allLoaded', { count: detail.interactions.length })}
              </div>}
            </div>
          </div>}
        </div>
      </TaskSurface>
    </div>
    {inspect && <Inspector node={inspect} loadSourceRecord={model.sourceRecord} onClose={() => setInspect(null)}/>} 
  </main>
}