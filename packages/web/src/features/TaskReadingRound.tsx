import type { ReactNode } from 'react'
import type { TaskRoundModel } from './task-detail-model'

/**
 * The single reading shell for Live and Review.
 * Round identity powers rail/navigation and virtualization only: no round
 * title, no whole-round disclosure, no duplicated process chrome.
 */
export interface TaskReadingRoundProps {
  model: TaskRoundModel
  prompt?: ReactNode
  process?: ReactNode
  answer?: ReactNode
  footer?: ReactNode
  className?: string
}

export function TaskReadingRound({
  model, prompt, process, answer, footer, className = '',
}: TaskReadingRoundProps) {
  return <section
    className={`task-reading-round interaction-block ${className}`.trim()}
    data-interaction-id={model.id}
    data-round-semantic-id={model.semanticId ?? model.id}
    data-round-label={model.label}
    data-round-preview={model.preview || undefined}
    data-round-error={model.errorCount > 0 ? 'true' : undefined}
    data-round-state={model.state}
  >
    {prompt}
    {process}
    {answer}
    {footer}
  </section>
}
