import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { TaskThinking } from './TaskThinking'
import { taskPreciseDurationLabel, type TaskRoundState, type TaskThinkingModel } from './task-detail-model'

export interface TaskProcessGroupProps {
  id: string
  messageCount: number
  toolCount: number
  errorCount?: number | undefined
  /** 兼容已知的直接耗时；优先使用 startedAtMs / endedAtMs 的真实过程边界。 */
  durationMs?: number | undefined
  /** Only native measured reasoning intervals, never total process/round duration. */
  thinkingDurationMs?: number | undefined
  startedAtMs?: number | undefined
  endedAtMs?: number | undefined
  state?: TaskRoundState | undefined
  defaultExpanded?: boolean | undefined
  expansionStore?: Map<string, boolean> | undefined
  onExpandedChange?: ((expanded: boolean) => void) | undefined
  summaryExtra?: ReactNode | undefined
  children: ReactNode
  className?: string | undefined
}

export function TaskProcessGroup({
  id,
  messageCount,
  toolCount,
  errorCount = 0,
  durationMs = 0,
  thinkingDurationMs,
  startedAtMs,
  endedAtMs,
  state = 'settled',
  defaultExpanded = false,
  expansionStore,
  onExpandedChange,
  summaryExtra,
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

  const hasThinkingDuration = thinkingDurationMs !== undefined && Number.isFinite(thinkingDurationMs) && thinkingDurationMs > 0
  const thoughtLabel = hasThinkingDuration
    ? t('thinking.thoughtFor', { value: taskPreciseDurationLabel(thinkingDurationMs) })
    : ''
  const model: TaskThinkingModel = {
    id,
    label: `${t('process.details')}${thoughtLabel ? `（${thoughtLabel}）` : ''}`,
    text: '',
    state,
  }

  return <TaskThinking
    model={model}
    kind="process"
    defaultExpanded={defaultExpanded}
    expansionStore={expansionStore}
    onExpandedChange={onExpandedChange}
    className={`task-process-group ${className}`.trim()}
    meta={<span className="task-process-summary">
      {messageCount > 0 && <span>{t('process.messages', { count: messageCount })}</span>}
      {toolCount > 0 && <span>{t('process.tools', { count: toolCount })}</span>}
      {(resolvedDurationMs > 0 || (state === 'running' && hasTimingBoundary)) && <span className="task-process-duration">{t('process.duration', { value: taskPreciseDurationLabel(resolvedDurationMs) })}</span>}
      {errorCount > 0 && <span className="task-process-summary-error">{t('process.errors', { count: errorCount })}</span>}
      {summaryExtra}
      {state === 'running' && <span>{t('process.running')}</span>}
    </span>}
  >
    {children}
  </TaskThinking>
}
