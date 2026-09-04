export type TaskRoundState = 'settled' | 'running' | 'stopped'
export type TaskToolKind = 'shell' | 'read' | 'edit' | 'search' | 'mcp' | 'web' | 'tool'
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
  state?: TaskRoundState | undefined
}

export interface TaskToolModel {
  id: string
  name: string
  kind: TaskToolKind
  kindLabel: string
  status: TaskToolStatus
  primary?: string | undefined
  secondary?: string | undefined
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
  id: string
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
