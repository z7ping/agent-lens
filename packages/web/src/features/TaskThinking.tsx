import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { TaskThinkingModel } from './task-detail-model'
import { UiIcon } from '../components/UiIcon'

export interface TaskThinkingProps {
  model: TaskThinkingModel
  meta?: ReactNode | undefined
  actions?: ReactNode | undefined
  children: ReactNode
  defaultExpanded?: boolean | undefined
  expansionStore?: Map<string, boolean> | undefined
  onExpandedChange?: ((expanded: boolean) => void) | undefined
  className?: string | undefined
  kind?: 'thinking' | 'process' | undefined
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
  kind = 'thinking',
}: TaskThinkingProps) {
  const { t } = useTranslation('task')
  const [expanded, setExpanded] = useState(() => expansionStore?.get(model.id) ?? defaultExpanded)
  const identityRef = useRef(model.id)
  const label = presentationLabel(model.label, t)
  const running = model.state === 'running'

  useEffect(() => {
    // 运行中 -> 已完成时不要重新按 defaultExpanded 折叠已经打开的内容。
    if (identityRef.current === model.id) return
    identityRef.current = model.id
    const stored = expansionStore?.get(model.id)
    const next = stored ?? defaultExpanded
    setExpanded(next)
    if (stored === undefined && defaultExpanded) expansionStore?.set(model.id, true)
  }, [defaultExpanded, expansionStore, model.id])

  return <details
    className={`task-thinking ${className}`.trim()}
    data-task-thinking-state={model.state ?? 'settled'}
    aria-busy={running || undefined}
    open={expanded}
    onToggle={event => {
      const next = event.currentTarget.open
      if (next === expanded) return
      setExpanded(next)
      expansionStore?.set(model.id, next)
      onExpandedChange?.(next)
    }}
  >
    <summary className="task-thinking-summary">
      <span className="task-thinking-summary-main">
        <DisclosureChevron/>
        <span className="task-thinking-kind-mark" aria-hidden="true"><UiIcon name={kind === 'process' ? 'task' : 'thinking'} size={14}/></span>
        <span className="task-thinking-label">{label}</span>
        <span className="task-thinking-running-mark" aria-hidden="true"><UiIcon name="loading" size={14}/></span>
        {model.preview && !expanded && <span className="task-thinking-preview">{model.preview}</span>}
      </span>
      <span className="task-thinking-summary-meta">{meta}{model.time && <time>{model.time}</time>}</span>
    </summary>
    {expanded && <div className="task-thinking-content">{children}</div>}
    {expanded && actions && <div className="task-thinking-actions">{actions}</div>}
  </details>
}
