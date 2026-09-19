import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { TaskThinking } from './TaskThinking'
import { taskPreciseDurationLabel, type TaskRoundState, type TaskThinkingModel } from './task-detail-model'

export interface TaskProcessGroupProps {
  id: string
  messageCount: number
  toolCount: number
  errorCount?: number
  durationMs?: number
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
  state = 'settled',
  defaultExpanded = state === 'running',
  children,
  className = '',
}: TaskProcessGroupProps) {
  const { t } = useTranslation('task')
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
      {durationMs > 0 && <span>{t('process.duration', { value: taskPreciseDurationLabel(durationMs) })}</span>}
      {errorCount > 0 && <span className="task-process-summary-error">{t('process.errors', { count: errorCount })}</span>}
      {state === 'running' && <span>{t('process.running')}</span>}
    </span>}
  >
    {children}
  </TaskThinking>
}
