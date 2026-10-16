import { translateProduct } from '../i18n/runtime'

export type TaskRoundState = 'settled' | 'running' | 'stopped'
export type TaskToolKind = 'shell' | 'read' | 'edit' | 'search' | 'test' | 'mcp' | 'web' | 'tool'
export type TaskToolStatus = 'running' | 'success' | 'error' | 'unknown'

export interface TaskMetricModel {
  label: string
  value: string | number
  tone?: 'danger' | 'accent' | undefined
}

export type TaskEventCategory = 'permission' | 'subagent' | 'context' | 'model' | 'lifecycle' | 'artifact' | 'usage' | 'unknown'

export interface TaskEventModel {
  id: string
  label: string
  category: TaskEventCategory
  summary?: string | undefined
  sourceLabel?: string | undefined
  time?: string | undefined
  nativeType?: string | undefined
  nativeId?: string | undefined
  parentId?: string | undefined
}

export interface TaskThinkingModel {
  id: string
  label: string
  text: string
  preview?: string | undefined
  time?: string | undefined
  /** Only the measured reasoning interval; never the whole turn duration. */
  durationMs?: number | undefined
  state?: TaskRoundState | undefined
}

export interface TaskToolModel {
  id: string
  name: string
  kind: TaskToolKind
  kindLabel: string
  toolSourceType?: 'builtin' | 'mcp' | 'plugin' | 'extension' | 'skill-runtime' | 'unknown' | undefined
  mcpServerId?: string | undefined
  status: TaskToolStatus
  primary?: string | undefined
  secondary?: string | undefined
  /** Full native tool input when available, never derived from a truncated preview. */
  rawInput?: string | undefined
  durationLabel?: string | undefined
  durationMs?: number | undefined
  startedAtMs?: number | undefined
  output?: string | undefined
}

export interface TaskToolKindCountModel {
  kind: TaskToolKind
  label: string
  count: number
}

export interface TaskToolGroupModel {
  id: string
  label: string
  itemCount: number
  errorCount: number
  totalDurationLabel?: string | undefined
  kindCounts: TaskToolKindCountModel[]
  tools: TaskToolModel[]
}

export interface TaskRoundModel {
  /** Render identity. Multiple render fragments may belong to one semantic round. */
  id: string
  /** Stable logical round identity used by cross-session navigation such as Turn Rail. */
  semanticId?: string | undefined
  ordinal?: number | undefined
  label: string
  state: TaskRoundState
  preview?: string | undefined
  toolCount: number
  errorCount: number
  durationMs: number
  highLatency: boolean
}

export interface TaskDetailModel {
  id: string
  title: string
  agentLabel: string
  /** Generic secondary context shown beside the agent, e.g. project or runtime model. */
  contextLabel?: string | undefined
  projectLabel?: string | undefined
  statusLabel?: string | undefined
  startedAt?: string | undefined
  endedAt?: string | undefined
  workspacePath?: string | undefined
  metrics: TaskMetricModel[]
  rounds: TaskRoundModel[]
}

export function taskDurationLabel(ms: number): string {
  const value = Math.max(0, ms)
  if (value < 1000) return translateProduct('task:duration.milliseconds', { value })
  if (value < 60_000) return translateProduct('task:duration.seconds', { value: (value / 1000).toFixed(value < 10_000 ? 1 : 0) })
  if (value < 3_600_000) return translateProduct('task:duration.minutes', { value: Math.round(value / 60_000) })
  if (value < 86_400_000) {
    const hours = value / 3_600_000
    return translateProduct('task:duration.hours', { value: hours < 10 ? hours.toFixed(1) : Math.round(hours) })
  }
  const days = value / 86_400_000
  return translateProduct('task:duration.days', { value: days < 10 ? days.toFixed(1) : Math.round(days) })
}

export function taskPreciseDurationLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 1) return translateProduct('task:duration.preciseSeconds', { seconds })

  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  if (hours < 1) return translateProduct('task:duration.preciseMinutesSeconds', { minutes, seconds })

  return translateProduct('task:duration.preciseHoursMinutesSeconds', { hours, minutes, seconds })
}

/** 仅拆解 Codex Desktop 明确的附件包头；普通正文、引用和不完整模板保持原样。
 * 这是展示用文本，原始消息、附件及 Evidence 仍由协议数据保留。
 */
export function taskUserRequestText(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n')
  if (!/^\s*# Files mentioned by the user:[ \t]*\n/.test(normalized)) return value
  const request = /^## My request:[ \t]*\n/gm.exec(normalized)
  if (!request) return value
  const context = normalized.slice(0, request.index)
  if (!/^## [^\n]+/m.test(context) || /^\s*```/m.test(context)) return value
  const text = normalized.slice(request.index + request[0].length).trim()
  return text || value
}

/** 页头标题只处理明确的行内 Markdown 语法，不修改原始 Session title。 */
export function readableTaskHeaderTitle(value: string | undefined): string {
  if (!value) return ''
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 轮次标题只展示可读摘要，不改变原始用户消息或证据。
 * Codex 的文件上下文包头不是提问，统一转为语义标签。
 */
export function taskRoundPreview(value: string | undefined, filesMentionedLabel: string): string | undefined {
  const original = value?.trim()
  if (!original) return undefined
  if (/^(?:#{1,6}\s*)?files mentioned by the user\s*:/i.test(original)) return filesMentionedLabel
  const text = original
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}(?:>\s*|[-*+]\s+)/gm, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  return text.length > 86 ? `${text.slice(0, 86)}…` : text
}

/**
 * 用于缺少项目关联时的紧凑展示；完整工作区路径仍应在任务信息中呈现。
 */
export function workspaceDisplayName(workspacePath: string | undefined): string | undefined {
  const normalized = workspacePath?.trim().replace(/[\\/]+$/, '')
  if (!normalized) return undefined
  const parts = normalized.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) || undefined
}
