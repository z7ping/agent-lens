export type TaskRoundState = 'settled' | 'running' | 'stopped'

export interface TaskMetricModel {
  label: string
  value: string | number
  tone?: 'danger' | 'accent' | undefined
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
