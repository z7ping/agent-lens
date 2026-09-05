import { useEffect, useState, type ReactNode } from 'react'
import type { TaskThinkingModel } from './task-detail-model'
import { UiIcon } from '../components/UiIcon'

export interface TaskThinkingProps {
  model: TaskThinkingModel
  meta?: ReactNode
  actions?: ReactNode
  children: ReactNode
  defaultExpanded?: boolean
  className?: string
}

function DisclosureChevron() {
  return <span className="task-disclosure-chevron task-thinking-chevron" aria-hidden="true">
    <UiIcon name="chevron-right" size={16}/>
  </span>
}

function presentationLabel(label: string): string {
  return label === '思考过程' ? '执行过程' : label
}

function resolvedDefaultExpanded(model: TaskThinkingModel, defaultExpanded: boolean) {
  // Review 的聚合执行过程承载 commentary 与具体工具调用，默认展开；
  // 独立 reasoning / thinking 仍尊重调用方传入的默认状态。
  return defaultExpanded || model.label === '思考过程' || model.label === '执行过程'
}

export function TaskThinking({
  model,
  meta,
  actions,
  children,
  defaultExpanded = true,
  className = '',
}: TaskThinkingProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const label = presentationLabel(model.label)

  useEffect(() => {
    setExpanded(resolvedDefaultExpanded(model, defaultExpanded))
  }, [defaultExpanded, model.id, model.label])

  return <details
    className={`task-thinking ${className}`.trim()}
    data-task-thinking-state={model.state ?? 'settled'}
    open={expanded}
    onToggle={event => setExpanded(event.currentTarget.open)}
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
