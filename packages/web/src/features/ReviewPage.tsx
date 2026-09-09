import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
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
import { historyTaskPresentation } from './task-center'
import { projectReviewInteractionPresentation, type ReviewProcessPresentationItem } from './review-interaction-presentation'
import { TaskEvent } from './TaskEvent'
import { TaskHeader } from './TaskHeader'
import { TaskMessage } from './TaskMessage'
import { TaskRound } from './TaskRound'
import { TaskSurface } from './TaskSurface'
import { TaskThinking } from './TaskThinking'
import { TaskToolGroup } from './TaskToolGroup'
import type { TaskDetailModel, TaskRoundModel, TaskThinkingModel, TaskToolGroupModel, TaskToolModel } from './task-detail-model'

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

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)
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

function cleanSessionTitle(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

function compactTitle(value: string | undefined, max = 92, fallback = '未命名会话'): string {
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
  if (value) return compactTitle(value, 74, '远程会话')
  if (item.title.state === 'redacted') return '标题已脱敏'
  if (item.title.state === 'omitted') return item.title.reason === 'policy' ? '标题未同步' : '远程会话'
  return '远程会话'
}

function hubSessionVisibility(item: HubReviewSessionSummaryDto, review: ReturnType<AgentLensClientModel['getSnapshot']>['review']): boolean {
  if (review.filters.sourceIds.length || review.filters.projectId || review.filters.status !== 'all') return false
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
    if (node.kind === 'session.lifecycle' && action === 'turn.context') return 'Codex 轮次上下文'
    if (node.kind === 'session.lifecycle' && action === 'turn.started') return 'Codex 轮次开始'
    if (node.kind === 'session.lifecycle' && action === 'turn.completed') return 'Codex 轮次完成'
    if (node.kind === 'session.lifecycle' && action === 'turn.aborted') return 'Codex 轮次中止'
    if (node.kind === 'session.lifecycle' && action === 'turn.error') return 'Codex 轮次错误'
    if (node.kind === 'context.compaction') return '上下文压缩'
    if (node.kind === 'context.injected') return '系统注入上下文'
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
  if (node.kind === 'context.injected') {
    const role = stringValue(payload, 'role')
    const text = stringValue(payload, 'text')
    if (text) return [role, brief(text, 180)].filter(Boolean).join(' · ')
    return role ? `${role} · 当前记录未包含正文` : '当前记录未包含正文'
  }
  if (node.kind === 'session.lifecycle') {
    if (action === 'turn.context') {
      const model = stringValue(payload, 'model')
      const cwd = stringValue(payload, 'cwd')
      const sandbox = brief(payload.sandbox_policy ?? payload.sandboxPolicy, 80)
      const approval = brief(payload.approval_policy ?? payload.approvalPolicy, 80)
      const reasoning = brief(payload.reasoning_effort ?? payload.reasoningEffort, 80)
      const collaboration = brief(payload.collaboration_mode ?? payload.collaborationMode, 80)
      return [model, cwd, sandbox ? `沙箱 ${sandbox}` : '', approval ? `审批 ${approval}` : '', reasoning ? `推理 ${reasoning}` : '', collaboration ? `协作 ${collaboration}` : ''].filter(Boolean).join(' · ') || brief(payload, 140)
    }
    if (action === 'session.discovered') {
      const parent = stringValue(payload, 'forked_from_id', 'parent_thread_id')
      const agent = stringValue(payload, 'agent_nickname', 'agent_path')
      const role = stringValue(payload, 'agent_role')
      const source = stringValue(payload, 'thread_source', 'source')
      return [parent ? `父线程 ${parent}` : '', agent ? `Agent ${agent}` : '', role, source].filter(Boolean).join(' · ') || brief(payload, 140)
    }
    const startSource = stringValue(payload, 'startSource', 'start_source', 'source')
    const reason = stringValue(payload, 'reason', 'lifecycleReason', 'lifecycle_reason', 'stopReason', 'stop_reason')
    const model = stringValue(payload, 'model')
    return [action, startSource ? `来源 ${startSource}` : '', reason ? `原因 ${reason}` : '', model].filter(Boolean).join(' · ') || brief(payload, 100)
  }
  if (node.kind === 'usage') {
    const input = numberValue(payload, 'inputTokens', 'input_tokens')
    const output = numberValue(payload, 'outputTokens', 'output_tokens')
    const cacheRead = numberValue(payload, 'cacheReadTokens', 'cached_input_tokens', 'cache_read_tokens')
    const total = numberValue(payload, 'totalTokens', 'total_tokens')
    if (input !== undefined || output !== undefined || cacheRead !== undefined || total !== undefined) {
      return [`输入 ${input ?? 0}`, `输出 ${output ?? 0}`, cacheRead ? `缓存读 ${cacheRead}` : '', total !== undefined ? `共 ${total}` : ''].filter(Boolean).join(' · ') + ' 个词元'
    }
  }
  if (node.kind === 'artifact.action') {
    const path = stringValue(payload, 'path', 'filePath', 'file_path')
    return [action, path].filter(Boolean).join(' · ') || brief(payload, 100)
  }
  return action || brief(payload, 100)
}

// ... CONTENT CONTINUES IDENTICALLY TO CURRENT REVIEWPAGE ...