import { useEffect, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { TaskThinkingModel } from './task-detail-model'
import { UiIcon } from '../components/UiIcon'

export interface TaskThinkingProps {
  model: TaskThinkingModel
  meta?: ReactNode
  actions?: ReactNode
  children: ReactNode
  defaultExpanded?: boolean
  expansionStore?: Map<string, boolean> | undefined
  onExpandedChange?: (expanded: boolean) => void
  className?: string
}

function DisclosureChevron() {
  return <span className="task-disclosure-chevron task-thinking-chevron" aria-hidden="true">
    <UiIcon name="chevron-right" size={16}/>
  </span>
}

function presentationLabel(label: string, t: TFunction): string {
  return label === t('thinking.thinkingProcess') ? t('thinking.executionProcess') : label
}

export function TaskThinking({
  model,
  meta,
  actions,
  children,
  defaultExpanded = true,
  expansionStore,
  onExpandedChange,
  className = '',
}: TaskThinkingProps) {
  const { t } = useTranslation('task')
  const [expanded, setExpanded] = useState(() => expansionStore?.get(model.id) ?? defaultExpanded)
  const label = presentationLabel(model.label, t)

  useEffect(() => {
    const stored = expansionStore?.get(model.id)
    const next = stored ?? defaultExpanded
    setExpanded(next)
    if (stored === undefined && defaultExpanded) expansionStore?.set(model.id, true)
  }, [defaultExpanded, expansionStore, model.id])

  return <details
    className={`task-thinking ${className}`.trim()}
    data-task-thinking-state={model.state ?? 'settled'}
    open={expanded}
    onToggle={event => {
      const next = event.currentTarget.open
      setExpanded(next)
      expansionStore?.set(model.id, next)
      onExpandedChange?.(next)
    }}
  >
    <summary className="task-thinking-summary">
      <span className="task-thinking-summary-main">
        <DisclosureChevron/>
        <span className="task-thinking-label">{label}</span>
        {model.preview && !expanded && <span className="task-thinking-preview">{model.preview}</span>}
      </span>
      <span className="task-thinking-summary-meta">{meta}{model.time && <time>{model.time}</time>}</span>
    </summary>
    {expanded && <div className="task-thinking-content">{children}</div>}
    {expanded && actions && <div className="task-thinking-actions">{actions}</div>}
  </details>
}
