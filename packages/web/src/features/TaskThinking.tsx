import { useEffect, useState, type ReactNode } from 'react'
import type { TaskThinkingModel } from './task-detail-model'

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
    <svg viewBox="0 0 16 16" fill="none"><path d="m6 4 4 4-4 4"/></svg>
  </span>
}

function initiallyExpanded(model: TaskThinkingModel, defaultExpanded: boolean) {
  // 聚合“思考过程”承载 commentary/reasoning 与具体工具调用。
  // 默认展开保证 Task Center 首屏不会把工具事实藏在第二层 disclosure 中；
  // 独立 Thinking / reasoning 仍尊重调用方的默认折叠设置。
  return defaultExpanded || model.label === '思考过程'
}

export function TaskThinking({
  model,
  meta,
  actions,
  children,
  defaultExpanded = true,
  className = '',
}: TaskThinkingProps) {
  const [expanded, setExpanded] = useState(() => initiallyExpanded(model, defaultExpanded))

  useEffect(() => {
    setExpanded(initiallyExpanded(model, defaultExpanded))
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
        <span className="task-thinking-label">{model.label}</span>
        {model.preview && !expanded && <span className="task-thinking-preview">{model.preview}</span>}
      </span>
      <span className="task-thinking-summary-meta">{meta}{model.time && <time>{model.time}</time>}</span>
    </summary>
    {expanded && <div className="task-thinking-content">{children}</div>}
    {expanded && actions && <div className="task-thinking-actions">{actions}</div>}
  </details>
}
