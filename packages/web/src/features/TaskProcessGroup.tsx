import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { TaskThinking } from './TaskThinking'
import { taskPreciseDurationLabel, type TaskRoundState, type TaskThinkingModel } from './task-detail-model'

export interface TaskProcessGroupProps {
  id: string
  messageCount: number
  toolCount: number
  errorCount?: number
  /** 兼容已知的直接耗时；优先使用 startedAtMs / endedAtMs 的真实过程边界。 */
  durationMs?: number
  startedAtMs?: number
  endedAtMs?: number
  state?: TaskRoundState
  defaultExpanded?: boolean
  children: ReactNode
  className?: string
}

export function TaskProcessGroup({
  id,
  messageCount,
  toolCount,
  errorCount = 0,
  durationMs = 0,
  startedAtMs,
  endedAtMs,
  state = 'settled',
  defaultExpanded = state === 'running',
  children,
  className = '',
}: TaskProcessGroupProps) {
  const { t } = useTranslation('task')
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (state !== 'running' || startedAtMs === undefined || endedAtMs !== undefined) return
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [endedAtMs, startedAtMs, state])

  const hasTimingBoundary = startedAtMs !== undefined && Number.isFinite(startedAtMs)
  const resolvedDurationMs = hasTimingBoundary
    ? Math.max(0, (endedAtMs ?? nowMs) - startedAtMs)
    : Math.max(0, durationMs)

  const model: TaskThinkingModel = {
    id,
    label: t('process.details'),
    text: '',
    state,
  }

  return <TaskThinking
    model={model}
    defaultExpanded={defaultExpanded}
    className={`task-process-group ${className}`.trim()}
    meta={<span className="task-process-summary">
      {messageCount > 0 && <span>{t('process.messages', { count: messageCount })}</span>}
      {toolCount > 0 && <span>{t('process.tools', { count: toolCount })}</span>}
      {resolvedDurationMs > 0 && <span>{t('process.duration', { value: taskPreciseDurationLabel(resolvedDurationMs) })}</span>}
      {errorCount > 0 && <span className="task-process-summary-error">{t('process.errors', { count: errorCount })}</span>}
      {state === 'running' && <span>{t('process.running')}</span>}
    </span>}
  >
    {children}
  </TaskThinking>
}
